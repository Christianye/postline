/**
 * Conservative trivial-query classifier for model routing. Returns true
 * only when the inbound text is short AND contains none of the keywords
 * that typically indicate the user wants the bot to invoke tools or
 * reason multi-step. Anything ambiguous classifies as non-trivial so the
 * primary model handles it.
 *
 * Calibration: false positive (primary used on trivial) is a small cost
 * waste; false negative (small model used on hard query) degrades the
 * answer, so we tune toward the primary.
 */
export function isTrivialQuery(text: string, maxChars: number): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) return false;
  // Lower-case for keyword scan; preserve original for length check.
  const lower = trimmed.toLowerCase();
  for (const kw of TRIVIAL_REJECT_KEYWORDS) {
    if (lower.includes(kw)) return false;
  }
  // Multi-line typically signals structured input (paste, snippet, etc.).
  if (trimmed.includes('\n')) return false;
  return true;
}

/**
 * Keywords that veto trivial classification. The list is intentionally
 * generous — any of these triggers a route to the primary model.
 *
 * Categories:
 * - English action verbs that imply tool use or multi-step reasoning
 * - Chinese verbs / mode words (跑/查/写/帮/搜/读/分析/解释/...)
 * - Punctuation patterns implying request structure (`?` count > 1, code,
 *   path / URL fragments)
 *
 * Keep all entries lower-case (we lower-case the input).
 */
const TRIVIAL_REJECT_KEYWORDS: readonly string[] = [
  // English actions
  'run',
  'execute',
  'check',
  'search',
  'fetch',
  'read',
  'write',
  'edit',
  'create',
  'delete',
  'remove',
  'install',
  'analyze',
  'explain',
  'compare',
  'review',
  'debug',
  'fix',
  'help me',
  'why does',
  'why is',
  'what does',
  'how does',
  'how do',
  'show me',
  'find',
  'list',
  // Tool / shell tokens
  'bash',
  'curl',
  'git ',
  'gh ',
  'sudo',
  'systemctl',
  '/tmp/',
  '/home/',
  'http://',
  'https://',
  '```',
  '$(',
  // Chinese intent verbs (single chars are common, scan substring match)
  '跑',
  '查',
  '搜',
  '读',
  '写',
  '改',
  '修',
  '删',
  '帮',
  '看',
  '解释',
  '分析',
  '比较',
  '为什么',
  '怎么',
  '怎样',
  '如何',
  '是不是',
] as const;

/**
 * Pick the model id for this turn given config + inbound text.
 *
 * Returns the primary model when routing is disabled or the query is
 * non-trivial; returns the configured `smallModel` only when the user's
 * text is unambiguously trivial.
 */
export function pickModel(
  primaryModel: string,
  inboundText: string,
  routing:
    | {
        enabled?: boolean;
        smallModel?: string;
        trivialMaxChars?: number;
      }
    | undefined,
): string {
  if (!routing?.enabled) return primaryModel;
  const max = routing.trivialMaxChars ?? 50;
  if (!isTrivialQuery(inboundText, max)) return primaryModel;
  return routing.smallModel ?? 'amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0';
}
