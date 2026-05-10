import type { ProviderSpec } from '@postline/providers';
import type { Config } from './config.js';

/**
 * Shim between the current env-driven Config and the Provider registry's
 * tagged-union ProviderSpec. When P2a.3 lands the real postline.config.ts,
 * the config will embed a ProviderSpec directly and this shim becomes a
 * straight passthrough (still useful as a seam for future legacy envs).
 */
export function providerSpecFromConfig(cfg: Config): ProviderSpec {
  // Phase 1 Config.provider is hard-coded to 'bedrock'; treat anything else
  // as an error so typos in future envs don't silently pick the wrong provider.
  if (cfg.provider === 'bedrock') {
    return {
      name: 'bedrock',
      region: cfg.region,
    };
  }
  const exhaustive: never = cfg.provider;
  throw new Error(`unsupported provider in config: ${String(exhaustive)}`);
}
