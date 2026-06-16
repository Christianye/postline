import { loadPostlineConfig, validateConfig } from '@postline/config';
import { createLogger } from '@postline/core';
import { canonicalizeCwd, reportingHostname } from './cc-worker/canonicalize.js';
import { runKeeper } from './cc-worker/keeper.js';
import {
  type PollResult,
  type RunnerOptions,
  backoffMs,
  pollOnce,
  registerWorker,
  runTask,
} from './cc-worker/runner.js';
import {
  clearWorkerState,
  isPidAlive,
  readWorkerState,
  writeWorkerState,
} from './cc-worker/state.js';
import { runWatch } from './cc-worker/watch.js';

/**
 * `postline cc-worker <start|stop|status>` — registers this CC's
 * working directory as a doorbell worker and long-polls for tasks.
 *
 * Designed to run in the foreground inside the operator's terminal
 * (the same terminal where their interactive `claude` is open). The
 * caller closes the terminal or hits Ctrl-C to stop. SIGTERM also
 * triggers a clean exit so `cc-worker stop` can target it by pid.
 */

const HELP = `Usage: postline cc-worker <command>

Commands:
  start    Register this cwd as a doorbell worker and long-poll for
           dispatched tasks. Runs in the foreground; Ctrl-C or SIGTERM
           triggers a clean exit.
  stop     Send SIGTERM to the worker recorded in the state file for
           the current cwd + host.
  status   Print the recorded worker state for the current cwd + host
           (pid, doorbellUrl, startedAt, alive?).
  watch    Read-only live view of all in-flight tasks across the bridge
           (doorbell GET /watch SSE). Add --plain for append-only output.
  keeper   Per-host supervisor (auto-default-worker C2): watch for wake
           intents and auto-start a worker for repos on this host's
           allowlist. --repo <abs-cwd> (repeatable) or CC_KEEPER_REPOS.

Required config:
  doorbell.enabled = true   in postline.config.ts on the BRIDGE side
  CC_DOORBELL_URL           env var pointing at the bridge (e.g.
                            http://localhost:9999 when SSM-tunneled)
  CC_DOORBELL_SECRET        env var holding the same secret as the
                            bridge's cfg.doorbell.secret
`;

export async function runCcWorker(argv: readonly string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(HELP);
    return;
  }
  switch (sub) {
    case 'start':
      await runStart(argv.slice(1));
      return;
    case 'stop':
      await runStop();
      return;
    case 'status':
      await runStatus();
      return;
    case 'watch':
      await runWatchCmd(argv.slice(1));
      return;
    case 'keeper':
      await runKeeperCmd(argv.slice(1));
      return;
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n`);
      process.stderr.write(HELP);
      process.exit(1);
  }
}

async function runStart(args: readonly string[] = []): Promise<void> {
  const cfg = await loadPostlineConfig();
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    process.stderr.write(`invalid config:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(2);
  }
  const log = createLogger({ level: cfg.logging?.level ?? 'info' });

  const doorbellUrl = process.env.CC_DOORBELL_URL ?? '';
  const secret = process.env.CC_DOORBELL_SECRET ?? '';
  if (!doorbellUrl || !secret) {
    process.stderr.write(
      'CC_DOORBELL_URL and CC_DOORBELL_SECRET must both be set in the environment.\n',
    );
    process.exit(2);
  }

  const cwd = canonicalizeCwd();
  const host = reportingHostname();
  // Surface a `💭 thinking` progress line only when explicitly opted in
  // (thinking can be long / sensitive). Off by default per
  // docs/designs/observability.md OQ-A1.
  const showThinking = process.env.CC_WORKER_SHOW_THINKING === '1';
  // Agent kind: `--agent <cc|codex>` flag, else CC_WORKER_AGENT_KIND env,
  // else default 'cc'. Drives both the registration metadata and which
  // headless binary runTask spawns.
  const agentIdx = args.indexOf('--agent');
  const agentKind =
    (agentIdx >= 0 ? args[agentIdx + 1] : undefined) ?? process.env.CC_WORKER_AGENT_KIND ?? 'cc';
  const opts: RunnerOptions = {
    doorbellUrl,
    secret,
    cwd,
    host,
    agentKind,
    pid: process.pid,
    log,
    ...(showThinking ? { showThinking: true } : {}),
  };

  log.info({ cwd, host, doorbellUrl }, 'cc_worker_starting');
  const reg = await registerWorker(opts).catch((err: Error) => {
    log.error({ err: err.message }, 'cc_worker_register_failed');
    process.exit(2);
  });
  if (!reg) return;
  let workerId = reg.workerId;
  log.info({ workerId, state: reg.state }, 'cc_worker_registered');

  writeWorkerState({
    host,
    cwd,
    pid: process.pid,
    doorbellUrl,
    startedAt: Date.now(),
    workerId,
  });

  let stopped = false;
  const cleanShutdown = () => {
    if (stopped) return;
    stopped = true;
    log.info({}, 'cc_worker_shutdown');
    clearWorkerState(host, cwd);
    process.exit(0);
  };
  process.on('SIGINT', cleanShutdown);
  process.on('SIGTERM', cleanShutdown);

  let backoffAttempt = 0;
  while (!stopped) {
    let result: PollResult;
    try {
      result = await pollOnce(opts, workerId);
      backoffAttempt = 0;
    } catch (err) {
      log.warn({ err: (err as Error).message, attempt: backoffAttempt }, 'cc_worker_poll_error');
      await sleep(backoffMs(backoffAttempt));
      backoffAttempt += 1;
      continue;
    }
    if (stopped) break;

    if (result.status === 'task' && result.task) {
      log.info({ taskId: result.task.taskId }, 'cc_worker_task_received');
      try {
        await runTask({ opts, workerId, task: result.task });
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'cc_worker_task_error');
      }
      // Loop straight back to poll without backoff.
      continue;
    }
    if (result.status === 'idle') {
      // Server returned 204 after long-poll timeout. Re-poll immediately.
      continue;
    }
    if (result.status === 'unknown_worker') {
      log.warn({ workerId }, 'cc_worker_unknown_re_register');
      const re = await registerWorker(opts).catch((err: Error) => {
        log.error({ err: err.message }, 'cc_worker_re_register_failed');
        return null;
      });
      if (!re) {
        await sleep(backoffMs(backoffAttempt));
        backoffAttempt += 1;
        continue;
      }
      workerId = re.workerId;
      writeWorkerState({
        host,
        cwd,
        pid: process.pid,
        doorbellUrl,
        startedAt: Date.now(),
        workerId,
      });
      continue;
    }
    if (result.status === 'demoted') {
      log.info({ workerId, body: result.errorBody }, 'cc_worker_demoted');
      // Per design §D05: a demoted worker keeps its existing in-flight
      // task ownership but its long-polls return 409. We re-register
      // (will go to standby tail) and keep polling — when the active
      // dies we'll be promoted. For v1 the simplest correct behaviour
      // is to loop straight back to poll; the server will respond with
      // 409 standby until promoted.
      continue;
    }
    if (result.status === 'standby') {
      log.info({ workerId }, 'cc_worker_standby_backoff');
      await sleep(5_000);
      continue;
    }
    log.warn({ result }, 'cc_worker_poll_unexpected');
    await sleep(backoffMs(backoffAttempt));
    backoffAttempt += 1;
  }
}

async function runStop(): Promise<void> {
  const cwd = canonicalizeCwd();
  const host = reportingHostname();
  const rec = readWorkerState(host, cwd);
  if (!rec) {
    process.stdout.write(`No cc-worker recorded for host=${host} cwd=${cwd}\n`);
    return;
  }
  if (!isPidAlive(rec.pid)) {
    process.stdout.write(`Recorded worker pid=${rec.pid} is no longer alive; clearing state.\n`);
    clearWorkerState(host, cwd);
    return;
  }
  try {
    process.kill(rec.pid, 'SIGTERM');
    process.stdout.write(`Sent SIGTERM to cc-worker pid=${rec.pid}\n`);
  } catch (err) {
    process.stderr.write(`failed to kill pid=${rec.pid}: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

async function runStatus(): Promise<void> {
  const cwd = canonicalizeCwd();
  const host = reportingHostname();
  const rec = readWorkerState(host, cwd);
  if (!rec) {
    process.stdout.write(`No cc-worker recorded for host=${host} cwd=${cwd}\n`);
    return;
  }
  const alive = isPidAlive(rec.pid);
  process.stdout.write(
    [
      `host:        ${rec.host}`,
      `cwd:         ${rec.cwd}`,
      `pid:         ${rec.pid} (${alive ? 'alive' : 'dead'})`,
      `doorbellUrl: ${rec.doorbellUrl}`,
      `workerId:    ${rec.workerId}`,
      `startedAt:   ${new Date(rec.startedAt).toISOString()}`,
      '',
    ].join('\n'),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runWatchCmd(args: readonly string[]): Promise<void> {
  const doorbellUrl = process.env.CC_DOORBELL_URL ?? '';
  const secret = process.env.CC_DOORBELL_SECRET ?? '';
  if (!doorbellUrl || !secret) {
    process.stderr.write(
      'CC_DOORBELL_URL and CC_DOORBELL_SECRET must both be set in the environment.\n',
    );
    process.exit(2);
  }
  const plain = args.includes('--plain');
  await runWatch({ doorbellUrl, secret, plain });
}

async function runKeeperCmd(args: readonly string[]): Promise<void> {
  const doorbellUrl = process.env.CC_DOORBELL_URL ?? '';
  const secret = process.env.CC_DOORBELL_SECRET ?? '';
  if (!doorbellUrl || !secret) {
    process.stderr.write(
      'CC_DOORBELL_URL and CC_DOORBELL_SECRET must both be set in the environment.\n',
    );
    process.exit(2);
  }
  // Repo allowlist: --repo <abs cwd> (repeatable) and/or CC_KEEPER_REPOS
  // (comma-separated). The keeper only auto-starts workers for these.
  const repos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) {
      repos.push(args[i + 1] as string);
      i++;
    }
  }
  for (const r of (process.env.CC_KEEPER_REPOS ?? '').split(',').map((s) => s.trim())) {
    if (r) repos.push(r);
  }
  if (repos.length === 0) {
    process.stderr.write(
      'keeper: no repos allowed. Pass --repo <abs-cwd> (repeatable) or set CC_KEEPER_REPOS.\n',
    );
    process.exit(2);
  }
  await runKeeper({ doorbellUrl, secret, repos });
}
