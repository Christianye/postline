/**
 * Split a long message into Telegram-sized chunks.
 *
 * Telegram's `sendMessage` / `editMessageText` hard-limit text to 4096 chars
 * (after entity parsing). We use a 4000 soft limit to leave room for the
 * chunk header.
 *
 * Strategy (first that fits wins):
 *   1. Whole text fits  → return [text]
 *   2. Split at paragraph boundaries (`\n\n`)
 *   3. Split at line boundaries     (`\n`)
 *   4. Hard split at `limit` chars  (last resort)
 *
 * Each chunk gets prefixed with `(N/total) ` when there are 2+ chunks.
 */
export function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const raw = splitRaw(text, limit);
  if (raw.length <= 1) return raw;
  const total = raw.length;
  return raw.map((part, i) => `(${i + 1}/${total}) ${part}`);
}

function splitRaw(text: string, limit: number): string[] {
  const byPara = greedyPack(text.split(/\n\n+/), '\n\n', limit);
  if (byPara.every((p) => p.length <= limit)) return byPara;

  const byLine: string[] = [];
  for (const para of byPara) {
    if (para.length <= limit) {
      byLine.push(para);
      continue;
    }
    byLine.push(...greedyPack(para.split(/\n/), '\n', limit));
  }
  if (byLine.every((p) => p.length <= limit)) return byLine;

  const out: string[] = [];
  for (const line of byLine) {
    if (line.length <= limit) {
      out.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += limit) {
      out.push(line.slice(i, i + limit));
    }
  }
  return out;
}

/**
 * Greedy pack pieces joined by `sep` into chunks ≤ limit.
 * Pieces bigger than limit are emitted as-is (caller must split further).
 */
function greedyPack(pieces: readonly string[], sep: string, limit: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (!cur) {
      cur = p;
      continue;
    }
    if (cur.length + sep.length + p.length <= limit) {
      cur += sep + p;
    } else {
      out.push(cur);
      cur = p;
    }
  }
  if (cur) out.push(cur);
  return out;
}
