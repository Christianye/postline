import { randomUUID } from 'node:crypto';
import { type FeishuChannel, createFeishuChannel } from '@postline/adapters-feishu';
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
    const preview = JSON.stringify(args).slice(0, 500);
    try {
      await channel.sendApprovalCard({
        conversationId: ctx.conversationId,
        actionId,
        toolName: tool.name,
        argsPreview: preview,
        ttlMinutes: 5,
      });
    } catch (e) {
      // If the card send fails (e.g. interactive-message scope missing),
      // fall back to a plain-text prompt so the /approve path still works.
      log.warn(
        { err: (e as Error).message, actionId },
        'approval_card_failed_falling_back_to_text',
      );
      const message = [
        `🦞 **Approval required** for ${tool.name} (dangerous)`,
        '',
        `args: \`${preview}\``,
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
  log.info({ allowlist: [...allowlist] }, 'feishu_start');

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
    if (evt.action === 'approve') {
      const ok = pending.approve(evt.actionId);
      return {
        toast: ok
          ? { type: 'success' as const, content: 'Approved.' }
          : { type: 'info' as const, content: 'Action expired or already resolved.' },
      };
    }
    if (evt.action === 'deny') {
      const ok = pending.deny(evt.actionId);
      return {
        toast: ok
          ? { type: 'success' as const, content: 'Denied.' }
          : { type: 'info' as const, content: 'Action expired or already resolved.' },
      };
    }
    return { toast: { type: 'info' as const, content: `Unknown action: ${evt.action}` } };
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
      void handleSlash(inbound, slash, pending, channel, log);
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
            ...(streamer ? { onTextDelta: (c) => streamer.onDelta(c.accumulated) } : {}),
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
): Promise<void> {
  const id = slash.arg;
  if (!id) {
    await channel.send({
      conversationId: inbound.conversationId,
      text: `usage: /${slash.cmd} <action-id>`,
    });
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
