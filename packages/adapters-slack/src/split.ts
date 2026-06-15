/**
 * Split a long message into Slack-sized chunks.
 *
 * Slack `chat.postMessage` accepts up to 40000 chars total but truncates
 * a single text block past ~3000 visually; we use a 3500 soft limit for
 * readable chunks, matching the feishu/telegram splitters' shape.
 *
 * Strategy (first that fits wins): whole → paragraph → line → hard split.
 * 2+ chunks get a `(N/total) ` prefix.
 */
export function splitForSlack(text: string, limit = 3500): string[] {
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
    for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
  }
  return out;
}

function greedyPack(pieces: readonly string[], sep: string, limit: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (!cur) {
      cur = p;
      continue;
    }
    if (cur.length + sep.length + p.length <= limit) cur += sep + p;
    else {
      out.push(cur);
      cur = p;
    }
  }
  if (cur) out.push(cur);
  return out;
}
