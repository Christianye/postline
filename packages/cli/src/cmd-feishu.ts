import { randomUUID } from 'node:crypto';
import {
  type FeishuChannel,
  buildResolvedCard,
  createFeishuChannel,
} from '@postline/adapters-feishu';
import { loadPostlineConfig, validateConfig } from '@postline/config';
import {
  type ImagePart,
  type InboundMessage,
  type OutboundMessage,
  type PendingActions,
  type Tool,
  type TurnExtras,
  createLogger,
  createPendingActions,
  runTurn,
} from '@postline/core';
import { createProvider } from '@postline/providers';
import { createStreamingMessage } from './feishu-stream.js';
import { createHistory } from './history-factory.js';
import { createFsMemory } from './memory-fs.js';
import { assembleTools } from './tool-assembly.js';
import { createUsageRecorder } from './usage-factory.js';

export async function runFeishu(): Promise<void> {
  const cfg = await loadPostlineConfig();
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    process.stderr.write(`invalid config:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(2);
  }

  const log = createLogger({ level: cfg.logging?.level ?? 'info' });

  if (!cfg.feishu) {
    process.stderr.write('config.feishu is not set; cannot start feishu bot.\n');
    process.exit(2);
  }

  const provider = createProvider(cfg.provider, {
    log,
    ...(cfg.fallbacks ? { fallbacks: cfg.fallbacks } : {}),
  });
  const memory = createFsMemory(cfg.memory.dir);
  const history = createHistory(cfg, log);
  const usageRecorder = createUsageRecorder(cfg, log);
  const pending: PendingActions = createPendingActions();
  const processStartedAtMs = Date.now();

  // -- Tool assembly — drives builtin list from postline.config.ts (or env),
  //    optionally augmenting with MCP servers per cfg.tools.mcp.
  const { tools, mcp, systemPromptSuffix } = await assembleTools(
    cfg,
    {
      memoryDir: cfg.memory.dir,
      feishu: { appId: cfg.feishu.appId, appSecret: cfg.feishu.appSecret },
      ...(cfg.history && cfg.history.kind === 'fs' ? { historyDir: cfg.history.dir } : {}),
      ...(cfg.usage && cfg.usage.kind === 'fs' ? { usageDir: cfg.usage.dir } : {}),
      pendingCountFn: () => pending.list().length,
      processStartedAtMs,
    },
    log,
  );
  log.info({ toolCount: tools.size, tools: [...tools.keys()] }, 'cc_tools_loaded');

  if (mcp) {
    const shutdown = () => {
      void mcp.shutdown();
    };
    process.once('exit', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  const channel = createFeishuChannel({
    appId: cfg.feishu.appId,
    appSecret: cfg.feishu.appSecret,
    log,
    ...(cfg.feishu.botOpenId ? { botOpenId: cfg.feishu.botOpenId } : {}),
    requireMention: cfg.feishu.requireMention ?? true,
  });

  // -- Approval gate: ask the user in the same chat, then wait up to 5min.
  //    Interactive approval card is the primary UX; text /approve <id>
  //    remains supported as a graceful fallback in case the feishu app
  //    doesn't have card_action events subscribed.
  async function approveDangerous(
    tool: Tool,
    args: Record<string, unknown>,
    ctx: { userId: string; conversationId: string },
  ): Promise<boolean> {
    const actionId = randomUUID().slice(0, 8);
    try {
      await channel.sendApprovalCard({
        conversationId: ctx.conversationId,
        actionId,
        toolName: tool.name,
        args,
        ttlMinutes: 5,
      });
    } catch (e) {
      // If the card send fails (e.g. interactive-message scope missing),
      // fall back to a plain-text prompt so the /approve path still works.
      log.warn(
        { err: (e as Error).message, actionId },
        'approval_card_failed_falling_back_to_text',
      );
      const fallbackPreview = JSON.stringify(args).slice(0, 500);
      const message = [
        `🦞 **Approval required** for ${tool.name} (dangerous)`,
        '',
        `args: \`${fallbackPreview}\``,
        '',
        `Reply with \`/approve ${actionId}\` within 5 minutes, or \`/deny ${actionId}\`.`,
      ].join('\n');
      try {
        await channel.send({ conversationId: ctx.conversationId, text: message });
      } catch (e2) {
        log.warn({ err: (e2 as Error).message }, 'approval_prompt_failed');
        return false;
      }
    }
    return pending.create({
      id: actionId,
      tool: tool.name,
      args,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      ttlMs: 5 * 60_000,
    });
  }

  const allowlist = new Set<string>(cfg.allowlist.openIds);
  const requesterOnly = cfg.feishu.approval?.requesterOnly ?? true;
  const approvalAdmins = new Set<string>(cfg.feishu.approval?.admins ?? []);
  log.info(
    { allowlist: [...allowlist], requesterOnly, admins: [...approvalAdmins] },
    'feishu_start',
  );

  const authorizeApprovalClick: ApprovalAuthorizer = (actionId, clickerOpenId, entry) =>
    authorizeApproval(
      { actionId, clickerOpenId, entry, requesterOnly, admins: approvalAdmins },
      log,
    );

  channel.onCardAction((evt) => {
    log.info({ action: evt.action, actionId: evt.actionId, from: evt.userId }, 'feishu_card_click');
    if (!allowlist.has(evt.userId)) {
      return {
        toast: {
          type: 'error',
          content: 'You are not on the allowlist for this bot.',
        },
      };
    }
    if (evt.action !== 'approve' && evt.action !== 'deny') {
      return { toast: { type: 'info' as const, content: `Unknown action: ${evt.action}` } };
    }
    // Snapshot the pending entry's metadata BEFORE resolving — approve/deny
    // delete the entry, but we still need toolName for the resolved card and
    // the requester for the authorization check.
    const entry = pending.get(evt.actionId);
    const auth = authorizeApprovalClick(evt.actionId, evt.userId, entry);
    if (auth.kind === 'deny') {
      return { toast: { type: 'error' as const, content: auth.toast } };
    }
    const ok =
      evt.action === 'approve' ? pending.approve(evt.actionId) : pending.deny(evt.actionId);
    if (!ok || !entry) {
      return {
        toast: { type: 'info' as const, content: 'Action expired or already resolved.' },
      };
    }
    const resolvedCard = buildResolvedCard({
      toolName: entry.tool,
      actionId: evt.actionId,
      decision: evt.action,
      actorOpenId: evt.userId,
      decidedAtMs: Date.now(),
    });
    return {
      toast: {
        type: 'success' as const,
        content: evt.action === 'approve' ? 'Approved.' : 'Denied.',
      },
      card: { type: 'raw' as const, data: resolvedCard },
    };
  });

  const stop = channel.listen((inbound: InboundMessage) => {
    log.info(
      {
        turn: inbound.id,
        from: inbound.userId,
        chat: inbound.conversationId,
        textLen: inbound.text.length,
      },
      'feishu_inbound',
    );

    // Slash commands FIRST — they bypass the turn loop entirely.
    const slash = parseSlash(inbound.text);
    if (slash?.cmd === 'approve' || slash?.cmd === 'deny') {
      void handleSlash(inbound, slash, pending, channel, log, (actionId, clicker, entry) =>
        authorizeApprovalClick(actionId, clicker, entry),
      );
      return;
    }

    void (async () => {
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 360_000);
      try {
        const extras: TurnExtras = {};
        const imageKeys = (inbound.meta?.imageKeys as readonly string[] | undefined) ?? [];
        const messageId = inbound.meta?.messageId as string | undefined;
        if (imageKeys.length > 0 && messageId) {
          const images = await downloadImagesForTurn(channel, messageId, imageKeys, log);
          if (images.length > 0) extras.images = images;
        }

        const streaming = cfg.feishu?.streaming === true;
        const streamer = streaming
          ? createStreamingMessage(channel, inbound.conversationId, log, {
              ...(cfg.feishu?.streamingDebounceMs !== undefined
                ? { debounceMs: cfg.feishu.streamingDebounceMs }
                : {}),
            })
          : undefined;

        const reply = await runTurn(
          inbound,
          {
            model: cfg.model,
            maxIterations: 8,
            allowlist,
            historyLimit: 40,
            log,
            ...(systemPromptSuffix ? { systemPromptSuffix } : {}),
            ...(streamer
              ? {
                  onTextDelta: (c) => streamer.onDelta(c.accumulated),
                  onStatus: (s) => streamer.onStatus(s),
                }
              : {}),
            approveDangerous: (tool, args, toolCtx) => approveDangerous(tool, args, toolCtx),
          },
          { provider, tools, memory, history, ...(usageRecorder ? { usageRecorder } : {}) },
          ac.signal,
          extras,
        );
        log.info({ turn: inbound.id, replyLen: reply.length }, 'feishu_turn_ok');
        if (!reply) return;

        if (streamer) {
          const result = await streamer.finish(reply);
          if (result.kind === 'edited') {
            log.info({ turn: inbound.id }, 'feishu_sent_streaming');
            return;
          }
          if (result.kind === 'overflow') {
            await channel.send({
              conversationId: inbound.conversationId,
              text: result.rest,
            });
            log.info(
              { turn: inbound.id, overflowLen: result.rest.length },
              'feishu_sent_streaming_overflow',
            );
            return;
          }
          // kind === 'failed' → fall through to one-shot send below
          log.warn({ turn: inbound.id }, 'feishu_streaming_failed_sending_full');
        }

        const out: OutboundMessage = {
          conversationId: inbound.conversationId,
          text: reply,
          meta: { replyToMessageId: inbound.meta?.messageId },
        };
        await channel.send(out);
        log.info({ turn: inbound.id }, 'feishu_sent');
      } catch (e) {
        log.error({ err: (e as Error).message, turn: inbound.id }, 'feishu_turn_error');
      } finally {
        clearTimeout(timeout);
      }
    })();
  });

  const shutdown = async () => {
    log.info({}, 'feishu_shutdown');
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise<void>(() => {});
}

interface Slash {
  cmd: string;
  arg: string;
}

function parseSlash(text: string): Slash | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const m = /^\/(\w+)(?:\s+(.+))?$/u.exec(trimmed);
  if (!m) return null;
  return { cmd: m[1] ?? '', arg: (m[2] ?? '').trim() };
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
const MAX_IMAGES_PER_TURN = 5;

async function downloadImagesForTurn(
  channel: FeishuChannel,
  messageId: string,
  imageKeys: readonly string[],
  log: ReturnType<typeof createLogger>,
): Promise<ImagePart[]> {
  const take = imageKeys.slice(0, MAX_IMAGES_PER_TURN);
  if (take.length < imageKeys.length) {
    log.warn(
      { total: imageKeys.length, taken: take.length },
      'feishu_image_limit_exceeded_truncating',
    );
  }
  const out: ImagePart[] = [];
  for (const key of take) {
    try {
      const { bytes, mimeType } = await channel.downloadImage(messageId, key);
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        log.warn(
          { key, bytes: bytes.byteLength, max: MAX_IMAGE_BYTES },
          'feishu_image_too_large_skipped',
        );
        continue;
      }
      out.push({ type: 'image', data: bytes.toString('base64'), mimeType });
      log.info({ key, bytes: bytes.byteLength, mimeType }, 'feishu_image_downloaded');
    } catch (e) {
      log.warn({ key, err: (e as Error).message }, 'feishu_image_download_failed');
    }
  }
  return out;
}

async function handleSlash(
  inbound: InboundMessage,
  slash: Slash,
  pending: PendingActions,
  channel: { send: (m: OutboundMessage) => Promise<void> },
  log: ReturnType<typeof createLogger>,
  authorize: (
    actionId: string,
    clickerOpenId: string,
    entry: ReturnType<PendingActions['get']>,
  ) => { kind: 'allow' } | { kind: 'deny'; toast: string },
): Promise<void> {
  const id = slash.arg;
  if (!id) {
    await channel.send({
      conversationId: inbound.conversationId,
      text: `usage: /${slash.cmd} <action-id>`,
    });
    return;
  }
  const entry = pending.get(id);
  const auth = authorize(id, inbound.userId, entry);
  if (auth.kind === 'deny') {
    await channel.send({ conversationId: inbound.conversationId, text: `⚠️ ${auth.toast}` });
    log.info({ cmd: slash.cmd, actionId: id, rejected: auth.toast }, 'slash_rejected');
    return;
  }
  const ok =
    slash.cmd === 'approve' ? pending.approve(id) : slash.cmd === 'deny' ? pending.deny(id) : false;
  const reply = ok
    ? `✅ ${slash.cmd}d action ${id}`
    : `⚠️ no pending action with id ${id} (expired or never existed)`;
  await channel.send({ conversationId: inbound.conversationId, text: reply });
  log.info({ cmd: slash.cmd, actionId: id, ok }, 'slash_handled');
}

/**
 * Result of an approval authorization decision. `allow` lets the caller
 * proceed; `deny` carries a toast/message string the caller must surface.
 */
export type ApprovalAuthDecision = { kind: 'allow' } | { kind: 'deny'; toast: string };

export type ApprovalAuthorizer = (
  actionId: string,
  clickerOpenId: string,
  entry: ReturnType<PendingActions['get']>,
) => ApprovalAuthDecision;

interface AuthorizeApprovalInput {
  actionId: string;
  clickerOpenId: string;
  entry: ReturnType<PendingActions['get']>;
  requesterOnly: boolean;
  admins: ReadonlySet<string>;
}

/**
 * Decide whether `clickerOpenId` may approve/deny the pending action `entry`.
 *
 * - Missing entry (expired / already resolved / never existed) → deny.
 * - `requesterOnly=false` → anyone in the channel-level allowlist passes
 *   (caller is responsible for the allowlist gate; this fn assumes it ran).
 * - `clickerOpenId === entry.userId` → allow.
 * - clicker is in `admins` → allow + audit-log `feishu_approval_override`.
 * - Otherwise → deny + audit-log `feishu_approval_rejected_not_requester`.
 *
 * Pure aside from the audit log call. Exported for unit tests.
 */
export function authorizeApproval(
  input: AuthorizeApprovalInput,
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
): ApprovalAuthDecision {
  const { actionId, clickerOpenId, entry, requesterOnly, admins } = input;
  if (!entry) return { kind: 'deny', toast: 'Action expired or already resolved.' };
  if (!requesterOnly) return { kind: 'allow' };
  if (entry.userId === clickerOpenId) return { kind: 'allow' };
  if (admins.has(clickerOpenId)) {
    log.info(
      { actionId, requester: entry.userId, override_by: clickerOpenId, tool: entry.tool },
      'feishu_approval_override',
    );
    return { kind: 'allow' };
  }
  log.warn(
    { actionId, requester: entry.userId, clicker: clickerOpenId },
    'feishu_approval_rejected_not_requester',
  );
  return { kind: 'deny', toast: 'Only the requester (or an admin) can resolve this action.' };
}
