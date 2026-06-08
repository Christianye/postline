import { randomUUID } from 'node:crypto';
import {
  type FeishuChannel,
  buildResolvedCard,
  createFeishuChannel,
} from '@postline/adapters-feishu';
import { loadPostlineConfig, validateConfig } from '@postline/config';
import {
  type DesignReviewPushHandle,
  type ImagePart,
  type InboundMessage,
  type OutboundMessage,
  type PendingActions,
  type RouteDecision,
  type RoutingLoaderHandle,
  type Tool,
  type TurnExtras,
  createLogger,
  createPendingActions,
  createPostlineMetrics,
  matchRoute,
  runTurn,
  startDesignReviewPushPoller,
  startRoutingLoader,
} from '@postline/core';
import {
  DoorbellCoordinator,
  type DoorbellServerHandle,
  startDoorbellServer,
} from '@postline/doorbell';
import { createProvider } from '@postline/providers';
import { createStreamingMessage } from './feishu-stream.js';
import { createHistory } from './history-factory.js';
import { auditHistoryDir } from './history-fs.js';
import { createFsMemory } from './memory-fs.js';
import { pickModel } from './routing.js';
import { buildRuntimeStateSuffix } from './runtime-state.js';
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

  const metrics = createPostlineMetrics();
  const provider = createProvider(cfg.provider, {
    log,
    ...(cfg.fallbacks ? { fallbacks: cfg.fallbacks } : {}),
    metrics,
  });
  const memory = createFsMemory(cfg.memory.dir);
  const history = createHistory(cfg, log, metrics);
  const usageRecorder = createUsageRecorder(cfg, log);
  const pending: PendingActions = createPendingActions();
  const processStartedAtMs = Date.now();

  // -- Tool assembly — drives builtin list from postline.config.ts (or env),
  //    optionally augmenting with MCP servers per cfg.tools.mcp.
  const historyDir = cfg.history && cfg.history.kind === 'fs' ? cfg.history.dir : undefined;
  const { tools, mcp, systemPromptSuffix } = await assembleTools(
    cfg,
    {
      memoryDir: cfg.memory.dir,
      feishu: { appId: cfg.feishu.appId, appSecret: cfg.feishu.appSecret },
      ...(historyDir ? { historyDir } : {}),
      ...(cfg.usage && cfg.usage.kind === 'fs' ? { usageDir: cfg.usage.dir } : {}),
      pendingCountFn: () => pending.list().length,
      processStartedAtMs,
      metrics,
      ...(historyDir ? { historyAuditFn: () => auditHistoryDir(historyDir) } : {}),
    },
    log,
  );
  log.info({ toolCount: tools.size, tools: [...tools.keys()] }, 'cc_tools_loaded');

  // Runtime-state fragment is computed once at startup and prepended to
  // any skill-derived suffix. Static for this process lifetime → keeps
  // the Anthropic prompt cache stable across turns.
  const runtimeStateSuffix = buildRuntimeStateSuffix(cfg);
  const fullSystemPromptSuffix = systemPromptSuffix
    ? `${runtimeStateSuffix}\n\n${systemPromptSuffix}`
    : runtimeStateSuffix;

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

  // -- Design-review push poller (PR-DB-0). Bridge-side proactive
  //    notification: watches docs/designs/*.md PR comments and DMs the
  //    operator on every new review activity. Runs only when the
  //    notify.designReviewPush block is configured AND has enabled=true.
  let designReviewPushHandle: DesignReviewPushHandle | undefined;
  if (cfg.notify?.designReviewPush?.enabled && cfg.notify.designReviewPush.repo) {
    const drp = cfg.notify.designReviewPush;
    designReviewPushHandle = startDesignReviewPushPoller({
      repo: drp.repo,
      receiverOpenId: drp.receiverOpenId,
      ...(drp.watchPaths !== undefined ? { watchPaths: drp.watchPaths } : {}),
      ...(drp.pollIntervalMs !== undefined ? { pollIntervalMs: drp.pollIntervalMs } : {}),
      ...(drp.stateFilePath !== undefined ? { stateFilePath: drp.stateFilePath } : {}),
      enabled: true,
      log,
      sendFeishuMessage: async ({ receiverOpenId, text }) => {
        await channel.sendDirectMessage({ openId: receiverOpenId, text });
      },
    });
  }

  // -- Doorbell server (PR-DB-1). Bridge-side HTTP surface that CC
  //    workers (cc-worker skill) register against. Default off; turn on
  //    by setting `doorbell.enabled = true` in postline.config.ts.
  let doorbellHandle: DoorbellServerHandle | undefined;
  let doorbellCoord: DoorbellCoordinator | undefined;
  if (cfg.doorbell?.enabled && cfg.doorbell.secret) {
    const db = cfg.doorbell;
    doorbellCoord = new DoorbellCoordinator({
      log,
      ...(db.queueMax !== undefined ? { queueMax: db.queueMax } : {}),
      ...(db.sweepIntervalMs !== undefined ? { sweepIntervalMs: db.sweepIntervalMs } : {}),
      ...(db.staleThresholdMs !== undefined ? { staleThresholdMs: db.staleThresholdMs } : {}),
    });
    doorbellCoord.start();
    doorbellHandle = await startDoorbellServer({
      coordinator: doorbellCoord,
      secret: db.secret,
      ...(db.host !== undefined ? { host: db.host } : {}),
      ...(db.port !== undefined ? { port: db.port } : {}),
      ...(db.longPollTimeoutMs !== undefined ? { longPollTimeoutMs: db.longPollTimeoutMs } : {}),
      ...(db.hmacWindowMs !== undefined ? { hmacWindowMs: db.hmacWindowMs } : {}),
      log,
      onFirstHostnameSeen: db.auditFeishuReceiverOpenId
        ? async ({ hostname, workerId, cwd, pid }) => {
            const text = `🔔 doorbell: new hostname \`${hostname}\` registered worker ${workerId} for cwd \`${cwd}\` (pid ${pid}). If unfamiliar, secret may have leaked.`;
            try {
              await channel.sendDirectMessage({
                openId: db.auditFeishuReceiverOpenId as string,
                text,
              });
            } catch (err) {
              log.warn(
                { err: (err as Error).message, hostname },
                'doorbell_first_hostname_dm_failed',
              );
            }
          }
        : () => {},
    });
    log.info(
      { host: doorbellHandle.address.host, port: doorbellHandle.address.port },
      'doorbell_started',
    );
  }

  // -- Router (PR-DB-2). Loads routing.md from the user's memory dir
  //    by default; chokidar-watches for live reloads. Decides per
  //    inbound message whether to dispatch to a doorbell worker, run
  //    the local turn loop, or reply with a 'no worker' hint.
  const routingMdPath =
    cfg.router?.routingMdPath ?? `${cfg.memory.dir.replace(/\/$/, '')}/routing.md`;
  const routingLoader: RoutingLoaderHandle = startRoutingLoader({
    path: routingMdPath,
    log,
    ...(cfg.router?.reloadDebounceMs !== undefined
      ? { reloadDebounceMs: cfg.router.reloadDebounceMs }
      : {}),
    onParseFailure: ({ path, message }) => {
      // Best-effort heads-up to the operator. The bridge keeps the
      // last good config; nothing about this is fatal.
      log.warn({ path, message }, 'routing_md_parse_failed_dm_skipped');
    },
  });
  const embeddedLlmEnabled = cfg.embeddedLlm?.enabled === true;

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
      // Router decision: dispatch to worker / run local turn / reject.
      const routingCfg = routingLoader.snapshot();
      const matched = matchRoute(routingCfg, {
        text: inbound.text,
        embeddedLlmEnabled,
        hasActiveWorkerForCwd: (cwd) =>
          doorbellCoord ? doorbellCoord.registry.activeForCwd(cwd) !== undefined : false,
      });
      log.info(
        { turn: inbound.id, decision: matched.decision.kind, reason: matched.decision.reason },
        'feishu_route',
      );
      const handled = await handleRouteDecision(
        inbound,
        matched.decision,
        matched.text,
        doorbellCoord,
        channel,
        log,
      );
      if (handled) return;

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

        // Pick model per turn — config.routing.enabled gates this; trivial
        // queries land on the small model, everything else on the primary.
        // Logged so we can audit routing decisions in journalctl.
        const turnModel = pickModel(cfg.model, inbound.text, cfg.routing);
        if (turnModel !== cfg.model) {
          log.info(
            { turn: inbound.id, model: turnModel, primary: cfg.model },
            'feishu_routing_small_model',
          );
        }
        const reply = await runTurn(
          inbound,
          {
            model: turnModel,
            maxIterations: 8,
            allowlist,
            historyLimit: 40,
            log,
            systemPromptSuffix: fullSystemPromptSuffix,
            ...(streamer
              ? {
                  onTextDelta: (c) => streamer.onDelta(c.accumulated),
                  onStatus: (s) => streamer.onStatus(s),
                  onThinkingDelta: (c) => streamer.onThinkingDelta(c.accumulated),
                }
              : {}),
            ...(cfg.inference?.thinking ? { thinking: cfg.inference.thinking } : {}),
            approveDangerous: (tool, args, toolCtx) => approveDangerous(tool, args, toolCtx),
          },
          {
            provider,
            tools,
            memory,
            history,
            metrics,
            ...(usageRecorder ? { usageRecorder } : {}),
          },
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
    designReviewPushHandle?.stop();
    try {
      await routingLoader.close();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'routing_loader_close_error');
    }
    if (doorbellHandle) {
      try {
        await doorbellHandle.close();
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'doorbell_close_error');
      }
    }
    doorbellCoord?.stop();
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

/**
 * Apply a router decision. Returns true if the message has been handled
 * (worker dispatch / reject reply); returns false to fall through to
 * the local turn loop (ec2_self_solve / ec2_direct_answer paths, only
 * meaningful when embedded LLM is enabled).
 */
async function handleRouteDecision(
  inbound: InboundMessage,
  decision: RouteDecision,
  text: string,
  doorbellCoord: DoorbellCoordinator | undefined,
  channel: FeishuChannel,
  log: ReturnType<typeof createLogger>,
): Promise<boolean> {
  if (decision.kind === 'dispatch_to_mac') {
    if (!doorbellCoord) {
      await channel.send({
        conversationId: inbound.conversationId,
        text:
          '🤔 Routing decided to dispatch to a CC worker, but the doorbell is not enabled on this bridge. ' +
          'Set `doorbell.enabled = true` in postline.config.ts to use worker dispatch.',
      });
      return true;
    }
    const cwd = decision.cwd;
    if (!cwd) {
      // No cwd resolved (e.g. plain `!cc do this thing` without alias).
      // We have no place to enqueue; tell the user.
      await channel.send({
        conversationId: inbound.conversationId,
        text:
          '🤔 No specific repo resolved for this request. Use `!cc:<repo>` (e.g. `!cc:postline run lint`) ' +
          'or mention a project name configured in `routing.md`.',
      });
      return true;
    }
    const enq = doorbellCoord.enqueueAndMaybeDispatch({
      cwd,
      prompt: text,
      ...(inbound.meta?.messageId ? { feishuMessageId: inbound.meta.messageId as string } : {}),
    });
    if (!enq.ok) {
      await channel.send({
        conversationId: inbound.conversationId,
        text: `🟠 Queue full for cwd \`${enq.error.cwd}\` (${enq.error.queueLen}/${enq.error.queueMax}). Try again after the active worker drains.`,
      });
      return true;
    }
    const hasActive = doorbellCoord.registry.activeForCwd(cwd) !== undefined;
    const status = hasActive
      ? '🟡 dispatched to mac'
      : '🟠 queued (no worker; will be lost if postline restarts)';
    await channel.send({
      conversationId: inbound.conversationId,
      text: `${status} · cwd=${cwd} · taskId=#${enq.task.taskId}`,
    });
    return true;
  }
  if (decision.kind === 'reject_no_worker') {
    const hint = decision.hintCwd ? ` (try \`!cc:${decision.hintCwd}\`)` : '';
    await channel.send({
      conversationId: inbound.conversationId,
      text: `🤔 No worker for this request${hint}. Start a CC worker for the relevant repo, or set \`embeddedLlm.enabled = true\` in postline.config.ts to answer locally.`,
    });
    return true;
  }
  if (decision.kind === 'reject_destructive_no_worker') {
    await channel.send({
      conversationId: inbound.conversationId,
      text: `🚫 Refused: this looks destructive (\`${decision.verbHit}\`) and no active CC worker is registered for the relevant repo. Start a worker first, then resend.`,
    });
    log.warn({ turn: inbound.id, verbHit: decision.verbHit }, 'feishu_route_destructive_refused');
    return true;
  }
  // ec2_self_solve / ec2_direct_answer fall through to the local turn loop.
  return false;
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
