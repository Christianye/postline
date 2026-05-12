import { describe, expect, it } from 'vitest';
import { estimateUsd, findModelPrice, formatUsd } from './pricing.js';

describe('findModelPrice', () => {
  it('picks the longest prefix match (opus over generic claude)', () => {
    const p = findModelPrice('amazon-bedrock/us.anthropic.claude-opus-4-7');
    expect(p?.input).toBe(15);
    expect(p?.output).toBe(75);
  });

  it('picks sonnet-4 over haiku-4 by substring', () => {
    const p = findModelPrice('anthropic/claude-sonnet-4-6');
    expect(p?.input).toBe(3);
  });

  it('handles haiku-4', () => {
    const p = findModelPrice('amazon-bedrock/global.anthropic.claude-haiku-4-5');
    expect(p?.output).toBe(5);
  });

  it('returns undefined for unknown model id', () => {
    expect(findModelPrice('gpt-5-turbo')).toBeUndefined();
    expect(findModelPrice('')).toBeUndefined();
  });
});

describe('estimateUsd', () => {
  it('computes input + output correctly', () => {
    // opus-4: 15 / 75 per million
    const usd = estimateUsd(
      { inputTokens: 1_000_000, outputTokens: 0 },
      'amazon-bedrock/us.anthropic.claude-opus-4-7',
    );
    expect(usd).toBeCloseTo(15);
  });

  it('factors cache read/creation when pricing and usage present', () => {
    const usd = estimateUsd(
      {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 100_000, // 0.1M × $1.5 = $0.15
        cacheCreationTokens: 10_000, // 0.01M × $18.75 = $0.1875
      },
      'claude-opus-4-7',
    );
    expect(usd).toBeDefined();
    if (usd !== undefined) {
      // input 1000×$15/M = $0.015; output 500×$75/M = $0.0375
      // + cache read $0.15 + cache creation $0.1875
      expect(usd).toBeCloseTo(0.015 + 0.0375 + 0.15 + 0.1875, 4);
    }
  });

  it('returns undefined for unknown model (no silent $0)', () => {
    expect(estimateUsd({ inputTokens: 1000, outputTokens: 500 }, 'gpt-5')).toBeUndefined();
  });

  it('handles zero usage', () => {
    expect(estimateUsd({ inputTokens: 0, outputTokens: 0 }, 'claude-opus-4')).toBe(0);
  });
});

describe('formatUsd', () => {
  it('uses 4 decimals for cents-and-up', () => {
    expect(formatUsd(1.23456)).toBe('$1.2346');
    expect(formatUsd(0.015)).toBe('$0.0150');
  });

  it('uses 6 decimals for sub-cent', () => {
    expect(formatUsd(0.001234)).toBe('$0.001234');
  });

  it('uses scientific for extremely small values', () => {
    expect(formatUsd(0.00001)).toMatch(/e-/);
  });
});
