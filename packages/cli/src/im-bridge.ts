import { basename } from 'node:path';
import { loadPostlineConfig, validateConfig } from '@postline/config';
import type { PostlineConfig } from '@postline/config';
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
 * The channel surface a button-approval IM bridge (telegram / slack) needs
 * from its adapter. Feishu's card-approval flow is richer and stays on its
 * own bespoke path (cmd-feishu.ts); this shared runner covers the two
 * adapters whose send/edit/approval shapes already line up.
 *
 * `editText(messageId, text, conversationId)` and `sendText` /`send` are
 * identical across TelegramChannel + SlackChannel, so they're typed
 * structurally here.
 */
export interface IMChannel {
  name: string;
  listen(onMessage: (msg: InboundMessage) => void | Promise<void>): () => Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  sendText(params: { conversationId: string; text: string }): Promise<{ messageId: string }>;
  editText(messageId: string, text: string, conversationId: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export interface ImBridgeOptions<C extends IMChannel> {
  /** Channel name for logs (telegram / slack). */
  channelName: string;
  /** Build the channel once the runner has a logger + config. */
  createChannel: (log: ReturnType<typeof createLogger>, cfg: PostlineConfig) => C | null;
  /**
   * Extra allowlist ids beyond `cfg.allowlist.openIds` (e.g. telegram
   * numeric ids, slack user ids). Merged into the effective allowlist.
   */
  extraAllowlist?: (cfg: PostlineConfig) => readonly (string | number)[];
  /**
   * Wire the channel's dangerous-tool approval flow. Returns an
   * `approveDangerous` callback for runTurn + (optionally) registers the
   * channel's click handler. Called once after the channel + pending +
   * allowlist are ready. Approval shapes differ per channel, so this is
   * the one channel-specific hook.
   */
  wireApproval: (params: {
    channel: C;
    pending: PendingActions;
    allowlist: Set<string>;
    log: ReturnType<typeof createLogger>;
  }) => (
    tool: Tool,
    args: Record<string, unknown>,
    ctx: { userId: string; conversationId: string },
  ) => Promise<boolean>;
}

/**
 * Channel-agnostic IM bridge daemon: config + provider/memory/tools
 * assembly, an own doorbell server + registry, routing.md loader, the
 * turn loop, and dispatch handling. Extracted from cmd-telegram so a new
 * adapter (slack) is wiring-only. Independent bridge per process.
 */
export async function runImBridge<C extends IMChannel>(opts: ImBridgeOptions<C>): Promise<void> {
  const cfg = await loadPostlineConfig();
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    process.stderr.write(`invalid config:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(2);
  }
  const log = createLogger({ level: cfg.logging?.level ?? 'info' });

  const channel = opts.createChannel(log, cfg);
  if (!channel) process.exit(2); // createChannel already wrote the reason

  const metrics = createPostlineMetrics();
  const provider = createProvider(cfg.provider, {
    log,
    ...(cfg.fallbacks ? { fallbacks: cfg.fallbacks } : {}),
    metrics,
  });
  const memory = createFsMemory(cfg.memory.dir);
  const history = createHistory(cfg, log, metrics);
  const usageRecorder = createUsageRecorder(cfg, log);
  const pending = createPendingActions();
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
    const shutdownMcp = () => void mcp.shutdown();
    process.once('exit', shutdownMcp);
    process.once('SIGINT', shutdownMcp);
    process.once('SIGTERM', shutdownMcp);
  }

  // taskId → IM conversation id (where progress/terminal edits go).
  // task.feishuMessageId holds the seed message id (generic IM msg-id slot).
  const imConversation = new Map<string, string>();

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
        const convoId = imConversation.get(task.taskId);
        if (convoId) {
          channel.editText(task.feishuMessageId, lines.join('\n'), convoId).catch((err: Error) => {
            log.warn({ err: err.message, taskId: task.taskId }, 'im_progress_edit_failed');
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
            log.warn({ err: err.message, taskId: task.taskId }, 'im_terminal_edit_failed');
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
  for (const id of opts.extraAllowlist?.(cfg) ?? []) allowlist.add(String(id));
  log.info({ allowlist: [...allowlist], channel: opts.channelName }, 'im_bridge_start');

  const approveDangerous = opts.wireApproval({ channel, pending, allowlist, log });

  const stop = channel.listen((inbound: InboundMessage) => {
    log.info(
      { turn: inbound.id, from: inbound.userId, chat: inbound.conversationId },
      'im_inbound',
    );

    // Text /approve /deny fallback (channel-agnostic).
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
        'im_route',
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
        await channel.send({ conversationId: inbound.conversationId, text: reply });
        log.info({ turn: inbound.id }, 'im_sent');
      } catch (e) {
        log.error({ err: (e as Error).message, turn: inbound.id }, 'im_turn_error');
      } finally {
        clearTimeout(timeout);
      }
    })();
  });

  const shutdown = async () => {
    log.info({ channel: opts.channelName }, 'im_bridge_shutdown');
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

/**
 * Actionable "start a worker" hint for the queue-and-hold path (C1). If the
 * prefix named an agent kind (`!pl@codex@repo`), suggest that kind; else
 * offer both. The operator runs this on the host that has the repo.
 */
function startWorkerHint(cwd: string, selector?: string): string {
  const cd = `cd ${cwd} && `;
  if (selector === 'codex') return `Start one: \`${cd}cc-worker start --agent codex\``;
  if (selector === 'cc') return `Start one: \`${cd}cc-worker start\``;
  return `Start one on that host: \`${cd}cc-worker start\` (or \`--agent codex\`).`;
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
  channel: IMChannel,
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
      log.info({ turn: inbound.id, selector: decision.selector, cwd }, 'im_route_selector');
    }
    const enq = doorbellCoord.enqueueAndMaybeDispatch({
      cwd,
      prompt: text,
      ...(decision.selector ? { selector: decision.selector } : {}),
    });
    if (!enq.ok) {
      await channel.send({
        conversationId: inbound.conversationId,
        text: `🟠 Queue full for cwd \`${enq.error.cwd}\` (${enq.error.queueLen}/${enq.error.queueMax}).`,
      });
      return true;
    }
    const hasActive = doorbellCoord.registry.activeForCwd(cwd, decision.selector) !== undefined;
    // C1 (auto-default-worker RFC): the task is already enqueued + held;
    // it drains as soon as a worker for this cwd registers. When none is up
    // yet, tell the operator exactly how to start one rather than a scary
    // "lost on restart". The bridge never spawns (RF2) — the operator (or a
    // future C2 keeper) brings the worker up on the host with the repo.
    const startHint = startWorkerHint(cwd, decision.selector);
    const seedText = hasActive
      ? `🟡 dispatched · cwd=${cwd} · taskId=#${enq.task.taskId}`
      : `🟠 queued #${enq.task.taskId} · no worker for \`${basename(cwd)}\` yet — runs as soon as one registers.\n${startHint}`;
    try {
      const seed = await channel.sendText({
        conversationId: inbound.conversationId,
        text: seedText,
      });
      const t = doorbellCoord.queue.get(enq.task.taskId);
      if (t) t.feishuMessageId = seed.messageId;
      imConversation.set(enq.task.taskId, inbound.conversationId);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'im_dispatch_seed_send_failed');
    }
    return true;
  }
  if (decision.kind === 'reject_no_worker') {
    // No cwd resolved from the message (keyword miss). Can't queue-hold
    // without a target, so point the operator at the explicit-repo form.
    const hint = decision.hintCwd ? ` (try \`!${wake}@${decision.hintCwd}\`)` : '';
    await channel.send({
      conversationId: inbound.conversationId,
      text: `🤔 Couldn't tell which repo this is for${hint}. Address one explicitly with \`!${wake}@<repo> …\`, or enable embeddedLlm for repo-less Q&A.`,
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
  return false;
}
