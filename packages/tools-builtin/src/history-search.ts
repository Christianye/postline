import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message, Tool } from '@postline/core';

export interface HistorySearchOptions {
  /** Absolute path to the history dir (cfg.history.dir). */
  dir: string;
}

/**
 * Grep the filesystem-backed conversation history — all `*.jsonl` files in
 * the history dir — for a literal substring or regex. Each match reports
 * the conversation hash (matches the filename stem), role, and a trimmed
 * snippet of the line that matched.
 *
 * Symmetric with memory_search: intentionally not an embedding index. At
 * single-operator scale (hundreds of files, thousands of lines each) a
 * plain grep is fast and auditable.
 *
 * Note: conversation ids in the filename are md5-hashed by FsHistoryStore,
 * so the ids aren't human-readable. The tool returns the hash so the
 * model / operator can correlate across turns without exposing raw chat
 * ids to every caller.
 */
export function createHistorySearchTool(opts: HistorySearchOptions): Tool {
  const { dir } = opts;

  return {
    name: 'history_search',
    description:
      'Search prior conversation history for a literal substring or regex across every persisted conversation. Returns conversation hash + role + matching snippet. Scales to a few hundred files. Useful for "when did we last talk about X?". Requires cfg.history = { kind: "fs", dir } — otherwise reports a friendly hint.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        regex: { type: 'boolean', description: 'Treat query as a regex. Default false.' },
        case_sensitive: { type: 'boolean', description: 'Default false.' },
        max_hits: {
          type: 'number',
          description: 'Cap on total hits returned. Default 40.',
        },
        hours: {
          type: 'number',
          description: 'Only scan files modified within the last N hours. Default: all.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args) {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'ERROR: query is required', isError: true };
      const caseSensitive = args.case_sensitive === true;
      const useRegex = args.regex === true;
      const maxHits = typeof args.max_hits === 'number' && args.max_hits > 0 ? args.max_hits : 40;
      const hoursWindow = typeof args.hours === 'number' && args.hours > 0 ? args.hours : undefined;

      let pattern: RegExp;
      try {
        pattern = useRegex
          ? new RegExp(query, caseSensitive ? '' : 'i')
          : new RegExp(escapeRegex(query), caseSensitive ? '' : 'i');
      } catch (e) {
        return { content: `ERROR: invalid regex: ${(e as Error).message}`, isError: true };
      }

      if (!existsSync(dir)) {
        return {
          content: '(history dir does not exist — enable cfg.history = { kind: "fs", dir: "..." })',
          meta: { hits: 0 },
        };
      }

      const cutoff = hoursWindow !== undefined ? Date.now() - hoursWindow * 60 * 60 * 1000 : 0;

      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
      } catch (e) {
        return {
          content: `ERROR: cannot read history dir: ${(e as Error).message}`,
          isError: true,
        };
      }

      if (files.length === 0) {
        return { content: '(no conversation history yet)', meta: { hits: 0 } };
      }

      const hits: string[] = [];
      let totalHits = 0;
      let truncated = false;
      let convsWithHits = 0;

      for (const file of files) {
        if (hoursWindow !== undefined) {
          try {
            const s = await stat(join(dir, file));
            if (s.mtimeMs < cutoff) continue;
          } catch {
            continue;
          }
        }

        let raw: string;
        try {
          raw = await readFile(join(dir, file), 'utf8');
        } catch {
          continue;
        }

        const convHash = file.replace(/\.jsonl$/, '');
        const matchesInFile: string[] = [];
        const lines = raw.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          let msg: Message;
          try {
            msg = JSON.parse(line) as Message;
          } catch {
            continue;
          }
          const text = extractText(msg);
          if (!text) continue;
          // Match the concatenated text; for each match, record at most one
          // line per message (not per inner newline) — conversation turns
          // are the natural unit.
          if (pattern.test(text)) {
            totalHits += 1;
            if (hits.length + matchesInFile.length < maxHits) {
              matchesInFile.push(
                `  turn ${i + 1} [${msg.role}]: ${trimSnippet(text, query, caseSensitive)}`,
              );
            } else {
              truncated = true;
            }
          }
        }
        if (matchesInFile.length > 0) {
          hits.push(convHash, ...matchesInFile);
          convsWithHits += 1;
        }
        if (hits.length >= maxHits) {
          truncated = true;
          break;
        }
      }

      if (hits.length === 0) {
        return {
          content: `no match for "${query}" in ${files.length} conversation(s)`,
          meta: { hits: 0, files: files.length },
        };
      }

      const header = `${totalHits} hit(s) across ${convsWithHits} conversation(s) (scanned ${files.length})${truncated ? ' — truncated' : ''}:`;
      return {
        content: [header, ...hits].join('\n'),
        meta: { hits: totalHits, files: files.length, convsWithHits, truncated },
      };
    },
  };
}

function extractText(msg: Message): string {
  if (!msg?.content) return '';
  const parts: string[] = [];
  for (const c of msg.content) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'tool_use' && c.name) {
      parts.push(`[tool_use ${c.name} ${JSON.stringify(c.input ?? {})}]`);
    } else if (c.type === 'tool_result' && typeof c.content === 'string') {
      parts.push(c.content);
    }
  }
  return parts.join('\n');
}

function trimSnippet(text: string, query: string, caseSensitive: boolean): string {
  // Pull the line (or 200-char window) around the first match so the output
  // is useful without dumping the whole message.
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const idx = haystack.indexOf(needle);
  if (idx < 0) {
    // Regex match where literal indexOf misses — fall back to first 200 chars.
    const flat = text.replace(/\s+/gu, ' ').slice(0, 200);
    return flat.length < text.length ? `${flat}…` : flat;
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + query.length + 140);
  const window = text.slice(start, end).replace(/\s+/gu, ' ');
  return (start > 0 ? '…' : '') + window + (end < text.length ? '…' : '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
