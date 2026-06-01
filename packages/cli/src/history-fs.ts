import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  HistoryStore,
  Logger,
  Message,
  MetricsRegistry,
  ToolResultPart,
  ToolUsePart,
} from '@postline/core';

/**
 * A filesystem-backed HistoryStore: one JSONL file per conversation, appended
 * on every `append()` call. Survives process restarts, so `cc.service`
 * restarts don't wipe in-flight conversations.
 *
 * File layout:
 *   <dir>/<conversationHash>.jsonl
 *
 * The hash protects the FS from odd conversation ids (colons, slashes). Each
 * line is a JSON-serialised Message.
 *
 * Read path walks the whole file on load — for single-operator use the
 * numbers are fine (we cap with the caller's `limit`, and history files
 * rarely exceed low-thousands of messages per chat). If that grows we can
 * paginate later.
 */
export function createFsHistory(opts: {
  dir: string;
  log?: Logger;
  metrics?: MetricsRegistry;
}): HistoryStore {
  const { dir, log, metrics } = opts;
  let inited = false;

  async function ensureDir(): Promise<void> {
    if (inited) return;
    await mkdir(dir, { recursive: true });
    inited = true;
  }

  function fileFor(cid: string): string {
    // md5 is fine — collision risk per deployment is astronomical, and we
    // only need stable filenames from arbitrary feishu chat_ids / open_ids.
    const h = createHash('md5').update(cid).digest('hex').slice(0, 16);
    return join(dir, `${h}.jsonl`);
  }

  return {
    async load(cid, limit) {
      await ensureDir();
      const path = fileFor(cid);
      if (!existsSync(path)) return [];
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (e) {
        log?.warn({ err: (e as Error).message, cid }, 'history_load_failed');
        return [];
      }
      const lines = raw.split('\n').filter((l) => l.length > 0);
      const out: Message[] = [];
      for (const line of lines) {
        try {
          out.push(JSON.parse(line) as Message);
        } catch {
          // Skip corrupt line (shouldn't happen, but we append atomically
          // and a crash mid-write could theoretically truncate the last
          // line). One bad line shouldn't lose the whole conversation.
          log?.warn({ cid }, 'history_skipped_corrupt_line');
        }
      }
      return sanitizeHistory(out.slice(-limit), log, cid, metrics);
    },
    async append(cid, msgs) {
      if (msgs.length === 0) return;
      await ensureDir();
      const path = fileFor(cid);
      const body = `${msgs.map((m) => JSON.stringify(m)).join('\n')}\n`;
      try {
        await appendFile(path, body, 'utf8');
      } catch (e) {
        log?.warn({ err: (e as Error).message, cid }, 'history_append_failed');
      }
    },
  };
}

/**
 * Drop orphan assistant tool_use messages — i.e. assistant messages with one
 * or more tool_use blocks whose ids aren't all matched by tool_result blocks
 * in the immediately following tool message. This protects the next turn
 * from sending a malformed conversation to the Anthropic API:
 *   "Expected toolResult blocks at messages.0.content for the following Ids".
 *
 * Such orphans can land on disk when a turn aborts mid-flight (stream error,
 * timeout) before the synthetic tool_result is appended. The save-side guard
 * in turn.ts prevents new orphans; this load-side pass cleans pre-existing
 * pollution without needing a manual jsonl wipe.
 *
 * Exported for tests; not part of the public package surface.
 */
export function sanitizeHistory(
  msgs: Message[],
  log?: Logger,
  cid?: string,
  metrics?: MetricsRegistry,
): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    // A bare role:'tool' message is always invalid on its own — tool_result
    // blocks must follow a matching assistant tool_use. The handler below
    // pairs them; anything reaching this branch is unpaired, so drop it.
    if (m.role === 'tool') {
      log?.warn({ cid }, 'history_orphan_tool_message_dropped');
      metrics?.inc('history_orphan_dropped_total', { kind: 'standalone_tool' });
      continue;
    }
    const toolUseIds =
      m.role === 'assistant'
        ? m.content.filter((c): c is ToolUsePart => c.type === 'tool_use').map((c) => c.id)
        : [];
    if (toolUseIds.length === 0) {
      out.push(m);
      continue;
    }
    const next = msgs[i + 1];
    const resultIds =
      next?.role === 'tool'
        ? next.content
            .filter((c): c is ToolResultPart => c.type === 'tool_result')
            .map((c) => c.toolUseId)
        : [];
    const allMatched = toolUseIds.every((id) => resultIds.includes(id));
    if (allMatched && next) {
      out.push(m, next);
      i++;
    } else {
      log?.warn({ cid, droppedIds: toolUseIds }, 'history_orphan_tool_use_dropped');
      metrics?.inc('history_orphan_dropped_total', { kind: 'orphan_tool_use' });
      // Don't advance i — if a mismatched tool message follows, it'll be
      // caught and dropped by the standalone-tool guard at the top of the
      // next iteration.
    }
  }
  return out;
}

/**
 * Per-file audit result. Counts are detection-only — no rows are dropped.
 * Mirrors the classification used by `sanitizeHistory` so the same row that
 * would be dropped on next load is the one counted here.
 */
export interface HistoryFileAudit {
  /** Hashed jsonl filename, no path. */
  file: string;
  /** Bytes on disk. */
  sizeBytes: number;
  /** Total well-formed JSON rows parsed. */
  rows: number;
  /** Lines that failed JSON.parse — couldn't even be classified. */
  corruptLines: number;
  /** Assistant rows whose tool_use blocks lack a matching tool_result. */
  orphanToolUseRows: number;
  /** Standalone tool messages (tool_result without preceding assistant tool_use). */
  standaloneToolRows: number;
  /** Convenience sum of the two orphan kinds. */
  totalOrphans: number;
}

/**
 * Run the same orphan-detection logic as `sanitizeHistory` but in count-only
 * mode — nothing is dropped, no metrics are incremented. Used by the
 * `postline_stats history_audit` action so operators can see which chats
 * carry the most orphans without mutating disk.
 */
export function auditHistoryMessages(msgs: Message[]): {
  rows: number;
  orphanToolUseRows: number;
  standaloneToolRows: number;
} {
  let orphanToolUseRows = 0;
  let standaloneToolRows = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role === 'tool') {
      standaloneToolRows += 1;
      continue;
    }
    const toolUseIds =
      m.role === 'assistant'
        ? m.content.filter((c): c is ToolUsePart => c.type === 'tool_use').map((c) => c.id)
        : [];
    if (toolUseIds.length === 0) continue;
    const next = msgs[i + 1];
    const resultIds =
      next?.role === 'tool'
        ? next.content
            .filter((c): c is ToolResultPart => c.type === 'tool_result')
            .map((c) => c.toolUseId)
        : [];
    const allMatched = toolUseIds.every((id) => resultIds.includes(id));
    if (allMatched && next) {
      i++; // skip the paired tool message
    } else {
      orphanToolUseRows += 1;
    }
  }
  return { rows: msgs.length, orphanToolUseRows, standaloneToolRows };
}

/**
 * Audit every jsonl in the history dir. Reads each file, parses lines,
 * runs the detection logic, and returns per-file counts plus a directory
 * total. Pure — does not mutate disk. O(total rows on disk); fine for the
 * single-operator scale postline targets (a few hundred files, low-thousands
 * of rows each).
 */
export async function auditHistoryDir(dir: string): Promise<{
  files: HistoryFileAudit[];
  total: { files: number; rows: number; orphans: number; corruptLines: number };
}> {
  if (!existsSync(dir)) {
    return { files: [], total: { files: 0, rows: 0, orphans: 0, corruptLines: 0 } };
  }
  const { stat } = await import('node:fs/promises');
  const files: HistoryFileAudit[] = [];
  let totalRows = 0;
  let totalOrphans = 0;
  let totalCorrupt = 0;
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  for (const f of entries) {
    const path = join(dir, f);
    let sizeBytes = 0;
    try {
      const s = await stat(path);
      sizeBytes = s.size;
    } catch {
      // File vanished between readdir and stat; skip.
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      files.push({
        file: f,
        sizeBytes,
        rows: 0,
        corruptLines: 0,
        orphanToolUseRows: 0,
        standaloneToolRows: 0,
        totalOrphans: 0,
      });
      continue;
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const msgs: Message[] = [];
    let corruptLines = 0;
    for (const line of lines) {
      try {
        msgs.push(JSON.parse(line) as Message);
      } catch {
        corruptLines += 1;
      }
    }
    const audit = auditHistoryMessages(msgs);
    const fileAudit: HistoryFileAudit = {
      file: f,
      sizeBytes,
      rows: audit.rows,
      corruptLines,
      orphanToolUseRows: audit.orphanToolUseRows,
      standaloneToolRows: audit.standaloneToolRows,
      totalOrphans: audit.orphanToolUseRows + audit.standaloneToolRows,
    };
    files.push(fileAudit);
    totalRows += audit.rows;
    totalOrphans += fileAudit.totalOrphans;
    totalCorrupt += corruptLines;
  }
  return {
    files,
    total: {
      files: files.length,
      rows: totalRows,
      orphans: totalOrphans,
      corruptLines: totalCorrupt,
    },
  };
}

/**
 * Utility for ops: list every conversation file in the history dir. Used by
 * `postline stats` and potential future admin commands.
 */
export async function listHistoryConversations(
  dir: string,
): Promise<Array<{ file: string; sizeBytes: number }>> {
  if (!existsSync(dir)) return [];
  const { stat } = await import('node:fs/promises');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  const out: Array<{ file: string; sizeBytes: number }> = [];
  for (const f of files) {
    try {
      const s = await stat(join(dir, f));
      out.push({ file: f, sizeBytes: s.size });
    } catch {
      // skip unreadable
    }
  }
  return out;
}
