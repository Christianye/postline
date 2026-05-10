import type { Logger, Provider } from '@postline/core';
import { AnthropicProvider, type AnthropicProviderOptions } from './anthropic/index.js';
import { BedrockProvider, type BedrockProviderOptions } from './bedrock/index.js';

/**
 * Tagged union for provider selection in user config.
 * Adding a new provider = adding a variant here + a case below + an impl.
 */
export type ProviderSpec =
  | {
      name: 'bedrock';
      /** e.g. 'us-west-2'; falls back to AWS_REGION env. */
      region?: string;
      /** Per-attempt timeout in ms. Default 180_000. */
      timeoutMs?: number;
    }
  | {
      name: 'anthropic';
      /** ANTHROPIC_API_KEY by default. */
      apiKey?: string;
      /** Optional base URL for proxies. */
      baseUrl?: string;
      timeoutMs?: number;
    };

export interface CreateProviderOpts {
  log: Logger;
  /** Model ids to try after the primary one fails. */
  fallbacks?: readonly string[];
}

/**
 * Build a Provider instance from a config-driven spec. Single entry point
 * callers (cmd-chat / cmd-feishu) use — they don't import concrete providers.
 */
export function createProvider(spec: ProviderSpec, opts: CreateProviderOpts): Provider {
  switch (spec.name) {
    case 'bedrock': {
      const bedrockOpts: BedrockProviderOptions = {
        log: opts.log,
        ...(spec.region ? { region: spec.region } : {}),
        ...(opts.fallbacks ? { fallbacks: opts.fallbacks } : {}),
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      };
      return new BedrockProvider(bedrockOpts);
    }
    case 'anthropic': {
      const anthropicOpts: AnthropicProviderOptions = {
        log: opts.log,
        ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
        ...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}),
        ...(opts.fallbacks ? { fallbacks: opts.fallbacks } : {}),
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      };
      return new AnthropicProvider(anthropicOpts);
    }
    default: {
      // Exhaustiveness check — TypeScript will flag new variants if we forget them.
      const _exhaustive: never = spec;
      throw new Error(`unknown provider: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
