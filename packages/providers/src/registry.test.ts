import { describe, expect, it } from 'vitest';
import { createLogger } from '@postline/core';
import { createProvider } from './registry.js';

const log = createLogger({ level: 'silent' });

describe('createProvider', () => {
  it('returns a BedrockProvider for { name: "bedrock" }', () => {
    const p = createProvider({ name: 'bedrock' }, { log });
    expect(p.name).toBe('bedrock');
    expect(typeof p.stream).toBe('function');
  });

  it('passes region through to the bedrock provider', () => {
    // No direct getter; smoke test that it doesn't throw.
    const p = createProvider(
      { name: 'bedrock', region: 'us-east-1', timeoutMs: 30_000 },
      { log, fallbacks: ['amazon-bedrock/global.anthropic.claude-sonnet-4-6'] },
    );
    expect(p.name).toBe('bedrock');
  });

  it('returns an AnthropicProvider for { name: "anthropic" }', () => {
    const p = createProvider({ name: 'anthropic', apiKey: 'sk-ant-test' }, { log });
    expect(p.name).toBe('anthropic');
    expect(typeof p.stream).toBe('function');
  });

  it('rejects unknown provider names at type level (runtime: caught by default branch)', () => {
    // @ts-expect-error — intentionally invalid variant
    expect(() => createProvider({ name: 'bogus' }, { log })).toThrow(/unknown provider/);
  });
});
