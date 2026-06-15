import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  type CallbackEvent,
  type TelegramChannel,
  createTelegramChannel,
} from '@postline/adapters-telegram';
import { loadPostlineConfig, validateConfig } from '@postline/config';
import {
  type InboundMessage,
  type OutboundMessage,
  type PendingActions,
  type RouteDecision,
  type Tool,
  createLogger,
  createPendingActions,
  createPostlineMetrics,
  matchRoute,
  runTurn,
  startRoutingLoader,
} from '@postline/core';
import {
  DoorbellCoordinator,
  type DoorbellServerHandle,
  type Task,
  startDoorbellServer,
} from '@postline/doorbell';
import { createProvider } from '@postline/providers';
import { createHistory } from './history-factory.js';
import { createFsMemory } from './memory-fs.js';
import { buildRuntimeStateSuffix } from './runtime-state.js';
import { assembleTools } from './tool-assembly.js';
import { createUsageRecorder } from './usage-factory.js';

/**
 * `postline telegram` — Telegram bridge daemon.
 *
 * Mirrors `runFeishu` but for the Telegram channel. Per the wake-prefix /
 * reframe model this is an independent bridge process: it owns its own
 * doorbell server + worker registry. Run either `postline feishu` or
 * `postline telegram` (or both, on distinct doorbell ports with workers
 * pointed at the one you want).
 *
 * Duplicate-first per `docs/designs/telegram-adapter.md` D1: the
 * channel-agnostic turn loop is copied here against TelegramChannel; the
 * shared StreamingChannel extraction (PR-DB-7) folds the two back together
 * once both adapters are real.
 *
 * Deferred vs runFeishu (documented, not silently dropped): live-typing
 * streaming edits, design-review push poller (feishu-DM specific), image
 * (photo) ingestion into turns — tracked as follow-ons.
 */
export async function runTelegram(): Promise<void> {
  const cfg = await loadPostlineConfig();
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    process.stderr.write(`invalid config:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(2);
  }

  const log = createLogger({ level: cfg.logging?.level ?? 'info' });

  if (!cfg.telegram) {
    process.stderr.write('config.telegram is not set; cannot start telegram bot.\n');
    process.exit(2);
  }
  const botToken = process.env.CC_TELEGRAM_BOT_TOKEN ?? cfg.telegram.botToken ?? '';
  if (!botToken) {
    process.stderr.write('CC_TELEGRAM_BOT_TOKEN env (or config.telegram.botToken) must be set.\n');
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

  const historyDir = cfg.history && cfg.history.kind === 'fs' ? cfg.history.dir : undefined;
  const { tools, mcp, systemPromptSuffix } = await assembleTools(
    cfg,
    {
      memoryDir: cfg.memory.dir,
      ...(historyDir ? { historyDir } : {}),
      ...(cfg.usage && cfg.usage.kind === 'fs' ? { usageDir: cfg.usage.dir } : {}),
      pendingCountFn: () => pending.list().length,
      processStartedAtMs,
      metrics,
    },
    log,
  );
  log.info({ toolCount: tools.size, tools: [...tools.keys()] }, 'cc_tools_loaded');

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

  const channel = createTelegramChannel({
    botToken,
    log,
    requireMention: cfg.telegram.requireMention ?? true,
    ...(cfg.telegram.apiBase ? { apiBase: cfg.telegram.apiBase } : {}),
  });

  // -- Doorbell server (own registry for this bridge). Reuses the same
  //    coordinator + progress hooks as feishu; the seed message id is
  //    stored in task.feishuMessageId (a generic "IM message id" slot).
  let doorbellHandle: DoorbellServerHandle | undefined;
  let doorbellCoord: DoorbellCoordinator | undefined;
  if (cfg.doorbell?.enabled && cfg.doorbell.secret) {
    const db = cfg.doorbell;
    const lastProgressEditAt = new Map<string, number>();
    const activityLog = new Map<string, string[]>();
    const ACTIVITY_MAX_LINES = 6;
    doorbellCoord = new DoorbellCoordinator({
      log,
      ...(db.queueMax !== undefined ? { queueMax: db.queueMax } : {}),
      ...(db.sweepIntervalMs !== undefined ? { sweepIntervalMs: db.sweepIntervalMs } : {}),
      ...(db.staleThresholdMs !== undefined ? { staleThresholdMs: db.staleThresholdMs } : {}),
      onTaskProgress: ({ task, summary, etaSeconds, event }) => {
        if (!task.feishuMessageId) return;
        if (event) {
          const icon = event.kind === 'tool' ? '🔧' : event.kind === 'thinking' ? '💭' : '·';
          const line = event.kind === 'text' ? event.label : `${icon} ${event.label}`;
          const logLines = activityLog.get(task.taskId) ?? [];
          if (logLines[logLines.length - 1] !== line) {
            logLines.push(line);
            if (logLines.length > ACTIVITY_MAX_LINES) logLines.shift();
            activityLog.set(task.taskId, logLines);
          }
        }
        const now = Date.now();
        const last = lastProgressEditAt.get(task.taskId) ?? 0;
        if (now - last < 5_000) return;
        lastProgressEditAt.set(task.taskId, now);
        const who = responderTag(doorbellCoord, task);
        const lines: string[] = [`🟡 ${who} · #${task.taskId} running · cwd=${task.cwd}`];
        if (etaSeconds !== undefined) lines[0] = `${lines[0]} · ETA ${etaSeconds}s`;
        const logLines = activityLog.get(task.taskId);
        if (logLines && logLines.length > 0) lines.push(...logLines);
        else if (summary) lines.push(summary);
        // task.feishuMessageId carries the telegram seed message id; the
        // conversation id is the cwd-independent chat, stashed in the task
        // prompt context via the seed below.
        const convoId = imConversation.get(task.taskId);
        if (convoId) {
          channel.editText(task.feishuMessageId, lines.join('\n'), convoId).catch((err: Error) => {
            log.warn({ err: err.message, taskId: task.taskId }, 'telegram_progress_edit_failed');
          });
        }
      },
      onTaskTerminal: ({ task, text, errorMessage }) => {
        if (!task.feishuMessageId) return;
        lastProgressEditAt.delete(task.taskId);
        activityLog.delete(task.taskId);
        const who = responderTag(doorbellCoord, task);
        let body: string;
        if (task.status === 'done') body = `🟢 ${who} · #${task.taskId} done\n${text ?? ''}`.trim();
        else if (task.status === 'timeout')
          body = `🔴 ${who} · #${task.taskId} timed out${errorMessage ? `: ${errorMessage}` : ''}`;
        else
          body = `🔴 ${who} · #${task.taskId} ${task.status}${errorMessage ? `: ${errorMessage}` : ''}`;
        if (body.length > 4000) body = `${body.slice(0, 3980)}\n…[truncated]`;
        const convoId = imConversation.get(task.taskId);
        if (convoId) {
          channel.editText(task.feishuMessageId, body, convoId).catch((err: Error) => {
            log.warn({ err: err.message, taskId: task.taskId }, 'telegram_terminal_edit_failed');
          });
        }
        imConversation.delete(task.taskId);
      },
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
      onFirstHostnameSeen: () => {},
    });
    log.info(
      { host: doorbellHandle.address.host, port: doorbellHandle.address.port },
      'doorbell_started',
    );
  }

  // taskId → telegram chat id, so progress/terminal edits know where to go.
  // (task.feishuMessageId holds the seed message id; this holds the chat.)
  const imConversation = new Map<string, string>();

  const routingMdPath =
    cfg.router?.routingMdPath ?? `${cfg.memory.dir.replace(/\/$/, '')}/routing.md`;
  const routingLoader = startRoutingLoader({
    path: routingMdPath,
    log,
    ...(cfg.router?.reloadDebounceMs !== undefined
      ? { reloadDebounceMs: cfg.router.reloadDebounceMs }
      : {}),
    onParseFailure: ({ path, message }) => {
      log.warn({ path, message }, 'routing_md_parse_failed_dm_skipped');
    },
  });
  const embeddedLlmEnabled = cfg.embeddedLlm?.enabled === true;

  const allowlist = new Set<string>(cfg.allowlist.openIds);
  // Telegram allowlist keys on numeric user ids (as strings).
  const telegramAllow = new Set<string>((cfg.telegram.allowlist ?? []).map((x) => String(x)));
  for (const id of telegramAllow) allowlist.add(id);
  log.info({ allowlist: [...allowlist] }, 'telegram_start');

  async function approveDangerous(
    tool: Tool,
    args: Record<string, unknown>,
    ctx: { userId: string; conversationId: string },
  ): Promise<boolean> {
    const actionId = randomUUID().slice(0, 8);
    const argsPreview = `args: ${JSON.stringify(args).slice(0, 300)}`;
    try {
      await channel.sendApproval({
        conversationId: ctx.conversationId,
        actionId,
        toolName: tool.name,
        ttlMinutes: 5,
        argsPreview,
      });
    } catch (e) {
      log.warn({ err: (e as Error).message, actionId }, 'telegram_approval_send_failed');
      return false;
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

  // Inline-keyboard approve/deny clicks.
  channel.onCallback(async (evt: CallbackEvent) => {
    const clicker = String(evt.userId);
    if (!allowlist.has(clicker)) return;
    const entry = pending.get(evt.actionId);
    if (!entry) return;
    // Resolve the pending action; the runTurn approval promise is waiting.
    if (evt.action === 'approve') pending.approve(evt.actionId);
    else pending.deny(evt.actionId);
    await channel.resolveApproval({
      callbackQueryId: evt.callbackQueryId,
      chatId: evt.chatId,
      messageId: evt.messageId,
      toolName: entry.tool,
      actionId: evt.actionId,
      decision: evt.action,
      actorId: evt.userId,
    });
  });

  const stop = channel.listen((inbound: InboundMessage) => {
    log.info(
      { turn: inbound.id, from: inbound.userId, chat: inbound.conversationId },
      'telegram_inbound',
    );

    // Text /approve /deny fallback.
    const slash = /^\/(approve|deny)\s+([0-9a-f]{4,8})\s*$/i.exec(inbound.text.trim());
    if (slash?.[1] && slash[2]) {
      const ok = slash[1].toLowerCase() === 'approve';
      const entry = pending.get(slash[2]);
      if (entry && allowlist.has(inbound.userId)) {
        if (ok) pending.approve(slash[2]);
        else pending.deny(slash[2]);
        void channel.send({
          conversationId: inbound.conversationId,
          text: ok ? `✅ Approved ${slash[2]}.` : `❌ Denied ${slash[2]}.`,
        });
      }
      return;
    }

    void (async () => {
      const routingCfg = routingLoader.snapshot();
      const matched = matchRoute(routingCfg, {
        text: inbound.text,
        embeddedLlmEnabled,
        hasActiveWorkerForCwd: (cwd) =>
          doorbellCoord ? doorbellCoord.registry.activeForCwd(cwd) !== undefined : false,
      });
      log.info(
        { turn: inbound.id, decision: matched.decision.kind, reason: matched.decision.reason },
        'telegram_route',
      );
      const handled = await handleRouteDecision(
        inbound,
        matched.decision,
        matched.text,
        doorbellCoord,
        channel,
        log,
        routingCfg.wake,
        imConversation,
      );
      if (handled) return;

      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 360_000);
      try {
        const reply = await runTurn(
          inbound,
          {
            model: cfg.model,
            maxIterations: 8,
            allowlist,
            historyLimit: 40,
            log,
            systemPromptSuffix: fullSystemPromptSuffix,
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
          {},
        );
        if (!reply) return;
        const out: OutboundMessage = { conversationId: inbound.conversationId, text: reply };
        await channel.send(out);
        log.info({ turn: inbound.id }, 'telegram_sent');
      } catch (e) {
        log.error({ err: (e as Error).message, turn: inbound.id }, 'telegram_turn_error');
      } finally {
        clearTimeout(timeout);
      }
    })();
  });

  const shutdown = async () => {
    log.info({}, 'telegram_shutdown');
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

function responderTag(coord: DoorbellCoordinator | undefined, task: Task): string {
  const worker = task.ownerWorkerId ? coord?.registry.get(task.ownerWorkerId) : undefined;
  const kind = worker?.agentKind ?? 'cc';
  const repo = basename(task.cwd);
  const host = worker?.hostname;
  return host ? `🤖 ${kind}@${repo} · ${host}` : `🤖 ${kind}@${repo}`;
}

async function handleRouteDecision(
  inbound: InboundMessage,
  decision: RouteDecision,
  text: string,
  doorbellCoord: DoorbellCoordinator | undefined,
  channel: TelegramChannel,
  log: ReturnType<typeof createLogger>,
  wake: string,
  imConversation: Map<string, string>,
): Promise<boolean> {
  if (decision.kind === 'dispatch_to_mac') {
    if (!doorbellCoord) {
      await channel.send({
        conversationId: inbound.conversationId,
        text: '🤔 Routing decided to dispatch to a CC worker, but the doorbell is not enabled on this bridge.',
      });
      return true;
    }
    const cwd = decision.cwd;
    if (!cwd) {
      await channel.send({
        conversationId: inbound.conversationId,
        text: `🤔 No specific repo resolved. Use \`!${wake}@<repo>\` or mention a project configured in routing.md.`,
      });
      return true;
    }
    if (decision.selector) {
      log.info(
        { turn: inbound.id, selector: decision.selector, cwd },
        'telegram_route_selector_advisory',
      );
    }
    const enq = doorbellCoord.enqueueAndMaybeDispatch({ cwd, prompt: text });
    if (!enq.ok) {
      await channel.send({
        conversationId: inbound.conversationId,
        text: `🟠 Queue full for cwd \`${enq.error.cwd}\` (${enq.error.queueLen}/${enq.error.queueMax}).`,
      });
      return true;
    }
    const hasActive = doorbellCoord.registry.activeForCwd(cwd) !== undefined;
    const status = hasActive ? '🟡 dispatched' : '🟠 queued (no worker; lost on bridge restart)';
    try {
      const seed = await channel.sendText({
        conversationId: inbound.conversationId,
        text: `${status} · cwd=${cwd} · taskId=#${enq.task.taskId}`,
      });
      const t = doorbellCoord.queue.get(enq.task.taskId);
      if (t) t.feishuMessageId = seed.messageId;
      imConversation.set(enq.task.taskId, inbound.conversationId);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'telegram_dispatch_seed_send_failed');
    }
    return true;
  }
  if (decision.kind === 'reject_no_worker') {
    const hint = decision.hintCwd ? ` (try \`!${wake}@${decision.hintCwd}\`)` : '';
    await channel.send({
      conversationId: inbound.conversationId,
      text: `🤔 No worker for this request${hint}. Start a CC worker for the relevant repo, or enable embeddedLlm.`,
    });
    return true;
  }
  if (decision.kind === 'reject_destructive_no_worker') {
    await channel.send({
      conversationId: inbound.conversationId,
      text: `🚫 Refused: looks destructive (\`${decision.verbHit}\`) and no active worker is registered. Start one first.`,
    });
    return true;
  }
  // ec2_self_solve / ec2_direct_answer fall through to the local turn loop.
  return false;
}
