import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Logger } from '../types.js';

/**
 * Design-review push poller.
 *
 * Why this exists: postline-the-bridge is the right place to watch for
 * design-doc PR comments and proactively notify the operator on Feishu.
 * mac CC writes the reviews; the bridge sees them via gh api polling and
 * pushes a one-line summary so the operator doesn't have to refresh
 * GitHub manually.
 *
 * Trust model: relies on `gh` being authenticated on the host running
 * postline (typical EC2 deploy already has `gh auth login` set up). The
 * Feishu push reuses the existing feishu_send pathway via the injected
 * `sendFeishuMessage` callback so we don't recreate Lark.Client wiring
 * here. Errors during a poll never crash the poller — they log and we
 * try again on the next tick.
 */

export interface DesignReviewPushOptions {
  /** Owner/repo to watch, e.g. "Christianye/postline". */
  repo: string;
  /**
   * Path prefixes that mark a PR as a design-doc review. A PR is
   * considered relevant if any file in its diff starts with one of these.
   * Default: ["docs/designs/"].
   */
  watchPaths?: readonly string[];
  /** Poll interval in milliseconds. Default 300_000 (5 minutes). */
  pollIntervalMs?: number;
  /** open_id of the operator to ping on Feishu. Required. */
  receiverOpenId: string;
  /**
   * Where to persist the per-(PR, comment_id) dedupe set. Default
   * `~/.postline/state/design-review-pushed.json`.
   */
  stateFilePath?: string;
  /** Master toggle. Default true. */
  enabled?: boolean;
  /**
   * Send hook. Receives the formatted text + receiver open_id. Returns a
   * promise; rejection just logs and the poller continues.
   */
  sendFeishuMessage: (params: { receiverOpenId: string; text: string }) => Promise<void>;
  /**
   * `gh` invoker. Defaults to spawning `gh` from the system PATH; tests
   * can pass an in-memory mock that returns fixture JSON.
   */
  ghJson?: <T>(args: readonly string[]) => Promise<T>;
  log: Logger;
}

export interface DesignReviewPushHandle {
  /** Stop the timer. Pending in-flight poll completes naturally. */
  stop(): void;
  /** Force a poll cycle, used by tests. */
  pollOnce(): Promise<void>;
}

interface DedupeState {
  /** Map of "<pr>:<commentId>" → ISO timestamp the push fired. */
  pushed: Record<string, string>;
}

interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  files: { path: string }[];
}

interface PullRequestComment {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
  html_url: string;
}

const DEFAULT_WATCH_PATHS = ['docs/designs/'] as const;
const DEFAULT_POLL_MS = 300_000;

export function startDesignReviewPushPoller(opts: DesignReviewPushOptions): DesignReviewPushHandle {
  const enabled = opts.enabled ?? true;
  if (!enabled) {
    opts.log.info({ component: 'design_review_push' }, 'design_review_push_disabled');
    return { stop: () => {}, pollOnce: async () => {} };
  }

  if (!opts.receiverOpenId) {
    throw new Error('startDesignReviewPushPoller: receiverOpenId is required');
  }
  if (!opts.repo.includes('/')) {
    throw new Error(`startDesignReviewPushPoller: repo must be "owner/name", got "${opts.repo}"`);
  }

  const watchPaths = opts.watchPaths ?? DEFAULT_WATCH_PATHS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const stateFilePath = opts.stateFilePath ?? defaultStatePath();
  const ghJson = opts.ghJson ?? defaultGhJson;
  const log = opts.log.child({ component: 'design_review_push', repo: opts.repo });

  log.info(
    { watchPaths: [...watchPaths], pollIntervalMs, stateFilePath },
    'design_review_push_started',
  );

  // Serialize ticks: a slow `gh` call can run longer than the interval,
  // and a kickoff + interval-fired tick must not overlap (double-push).
  let tickInFlight: Promise<void> | null = null;
  const tick = async (): Promise<void> => {
    if (tickInFlight) {
      await tickInFlight;
      return;
    }
    tickInFlight = (async () => {
      try {
        await pollOnce({ ...opts, watchPaths, stateFilePath, ghJson, log });
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'design_review_push_tick_error');
      } finally {
        tickInFlight = null;
      }
    })();
    await tickInFlight;
  };

  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  // Kick off an immediate first cycle so a freshly-deployed bridge starts
  // catching up without waiting one full interval.
  void tick();

  return {
    stop: () => {
      clearInterval(timer);
      log.info({}, 'design_review_push_stopped');
    },
    pollOnce: tick,
  };
}

/**
 * Determine whether a comment counts as a "design-doc review" for the
 * given PR. Pure: takes the PR file list + watch-path prefixes; no I/O.
 * Exported so tests can pin the matcher independent of `gh`.
 */
export function isDesignReviewPr(
  prFiles: readonly { path: string }[],
  watchPaths: readonly string[],
): boolean {
  for (const f of prFiles) {
    for (const prefix of watchPaths) {
      if (f.path.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** Build the one-line Feishu message body. */
export function formatPushMessage(params: {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  commentAuthor: string;
  commentSnippet: string;
}): string {
  // Snippet is the first non-empty line of the comment body, capped to 80
  // chars so the operator sees the gist; clicking the URL opens the full
  // review thread.
  return `📋 PR #${params.prNumber} ${params.prTitle} · review by @${params.commentAuthor} · ${params.commentSnippet} → ${params.prUrl}`;
}

interface PollContext extends DesignReviewPushOptions {
  watchPaths: readonly string[];
  stateFilePath: string;
  ghJson: <T>(args: readonly string[]) => Promise<T>;
  log: Logger;
}

async function pollOnce(ctx: PollContext): Promise<void> {
  const state = loadState(ctx.stateFilePath);

  // List open PRs first; cheap one-shot. We could narrow with `--search`
  // by label/path but the open-PR count for this repo is small enough
  // that the brute-force scan is acceptable and easier to reason about.
  const prs = await ctx.ghJson<PullRequestSummary[]>([
    'pr',
    'list',
    '--repo',
    ctx.repo,
    '--state',
    'open',
    '--json',
    'number,title,url,state',
    '--limit',
    '50',
  ]);

  for (const pr of prs) {
    // Files for this specific PR. Only gh-fetched if the PR is open.
    const fileList = await ctx.ghJson<{ files: { path: string }[] }>([
      'pr',
      'view',
      String(pr.number),
      '--repo',
      ctx.repo,
      '--json',
      'files',
    ]);
    if (!isDesignReviewPr(fileList.files, ctx.watchPaths)) continue;

    // Pull all issue comments. Reviews bodies (top-level review summaries
    // from `gh pr review`) live on a separate endpoint; v1 watches issue
    // comments only because that's how mac CC currently writes reviews
    // (`gh pr comment ...`). If review summaries become a thing later,
    // extend with `gh api repos/{repo}/pulls/{pr}/reviews`.
    const comments = await ctx.ghJson<PullRequestComment[]>([
      'api',
      `repos/${ctx.repo}/issues/${pr.number}/comments`,
      '--jq',
      '[ .[] | { id, user, body, created_at, html_url } ]',
    ]);

    for (const c of comments) {
      const key = `${pr.number}:${c.id}`;
      if (state.pushed[key]) continue;
      // Skip self-authored comments. The bot account should never wake
      // itself up; same for messages without a known login.
      const author = c.user?.login ?? 'unknown';
      if (author === 'unknown') continue;

      const snippet = firstNonEmptyLine(c.body).slice(0, 80);
      const text = formatPushMessage({
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.url,
        commentAuthor: author,
        commentSnippet: snippet,
      });

      try {
        await ctx.sendFeishuMessage({ receiverOpenId: ctx.receiverOpenId, text });
        state.pushed[key] = new Date().toISOString();
        ctx.log.info({ pr: pr.number, commentId: c.id, author }, 'design_review_push_sent');
      } catch (err) {
        ctx.log.warn(
          { pr: pr.number, commentId: c.id, err: (err as Error).message },
          'design_review_push_send_error',
        );
        // Don't mark as pushed — retry next tick.
      }
    }
  }

  saveState(ctx.stateFilePath, state);
}

function loadState(path: string): DedupeState {
  if (!existsSync(path)) return { pushed: {} };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DedupeState>;
    if (!parsed.pushed || typeof parsed.pushed !== 'object') return { pushed: {} };
    return { pushed: { ...parsed.pushed } };
  } catch {
    return { pushed: {} };
  }
}

function saveState(path: string, state: DedupeState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {
    // Persistence is best-effort; in-memory dedupe still works for the
    // process lifetime even if the file can't be written.
  }
}

function defaultStatePath(): string {
  const root = process.env.CC_STATE_DIR;
  if (root && root.trim().length > 0) {
    return join(resolve(root.trim()), 'design-review-pushed.json');
  }
  return join(homedir(), '.postline', 'state', 'design-review-pushed.json');
}

function firstNonEmptyLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return '';
}

const defaultGhJson = async <T>(args: readonly string[]): Promise<T> => {
  const { spawn } = await import('node:child_process');
  return new Promise<T>((res, rej) => {
    const child = spawn('gh', [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', (err) => rej(err));
    child.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8');
        rej(new Error(`gh ${args.join(' ')} exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const out = Buffer.concat(chunks).toString('utf8');
        res(JSON.parse(out) as T);
      } catch (e) {
        rej(new Error(`gh ${args.join(' ')} JSON parse failed: ${(e as Error).message}`));
      }
    });
  });
};
