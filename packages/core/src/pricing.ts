import type { TokenUsage } from './types.js';

/**
 * Per-million-token USD pricing. Values are approximate public list prices;
 * enterprise contracts / volume discounts are not reflected.
 *
 * The mapping keys are prefix-matched against the model id — e.g. a model id
 * of "amazon-bedrock/us.anthropic.claude-opus-4-7" resolves by finding the
 * longest key that is a substring of the id. If nothing matches, return
 * undefined; callers should render "?" in that case rather than guessing.
 *
 * When Anthropic / AWS move prices, this file is the only thing to bump.
 */
export interface ModelPrice {
  /** USD per 1,000,000 input tokens (fresh, billed at full rate). */
  input: number;
  /** USD per 1,000,000 output tokens. */
  output: number;
  /** USD per 1,000,000 tokens SERVED from prompt cache (big discount). */
  cacheRead?: number;
  /** USD per 1,000,000 tokens WRITTEN to the prompt cache (premium). */
  cacheCreation?: number;
}

/**
 * Prefix table — the longest matching substring wins.
 * Prices as of 2026-05; keep in sync with Anthropic + Bedrock public pages.
 */
const TABLE: ReadonlyArray<readonly [string, ModelPrice]> = [
  // Claude 4 family
  ['claude-opus-4', { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }],
  ['claude-haiku-4', { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 }],
  // Older Claude 3.5 — kept for users who pin older fallbacks
  ['claude-3-5-sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1 }],
] as const;

export function findModelPrice(modelId: string): ModelPrice | undefined {
  let best: { len: number; price: ModelPrice } | undefined;
  for (const [prefix, price] of TABLE) {
    if (modelId.includes(prefix) && (!best || prefix.length > best.len)) {
      best = { len: prefix.length, price };
    }
  }
  return best?.price;
}

/**
 * Estimate USD for a given usage + model id. Returns undefined when we have
 * no pricing entry; don't silently render $0 for unknown models.
 */
export function estimateUsd(usage: TokenUsage, modelId: string): number | undefined {
  const price = findModelPrice(modelId);
  if (!price) return undefined;
  const m = 1_000_000;
  let usd = (usage.inputTokens * price.input) / m + (usage.outputTokens * price.output) / m;
  if (usage.cacheReadTokens && price.cacheRead !== undefined) {
    usd += (usage.cacheReadTokens * price.cacheRead) / m;
  }
  if (usage.cacheCreationTokens && price.cacheCreation !== undefined) {
    usd += (usage.cacheCreationTokens * price.cacheCreation) / m;
  }
  return usd;
}

export function formatUsd(n: number): string {
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}
