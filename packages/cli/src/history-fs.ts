import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryStore, Logger, Message } from '@postline/core';

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
export function createFsHistory(opts: { dir: string; log?: Logger }): HistoryStore {
  const { dir, log } = opts;
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
      return out.slice(-limit);
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
