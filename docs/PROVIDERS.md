# Providers reference

A provider is the LLM backend. postline ships two:

- **Bedrock** (`@aws-sdk/client-bedrock-runtime`) — default, runs inside AWS
- **Anthropic API** (`@anthropic-ai/sdk`) — direct Anthropic endpoint

Both support streaming, tool use, vision (images), and a fallback chain. They implement the same `Provider` interface from `@postline/core`.

## Config

### Bedrock

```ts
provider: { name: 'bedrock', region: 'us-west-2' }
model: 'amazon-bedrock/us.anthropic.claude-opus-4-7'
```

Credentials come from the standard AWS SDK chain:

1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env
2. `~/.aws/credentials` / `~/.aws/config` profile
3. EC2 instance profile / ECS task role (IMDS)
4. SSO

The provider does not consume AWS credentials itself — it just instantiates `BedrockRuntimeClient`.

Model ids accept both `amazon-bedrock/<id>` and `<id>` bare. Use the Bedrock-specific id format (e.g. `us.anthropic.claude-opus-4-7` with the region prefix; `global.anthropic.claude-sonnet-4-6` for cross-region).

### Anthropic

```ts
provider: { name: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }
model: 'anthropic/claude-opus-4-7'
```

`apiKey` is optional — falls back to `ANTHROPIC_API_KEY` env. Set `baseUrl` to route through a proxy.

Model ids: `claude-opus-4-7`, `claude-sonnet-4-6`, etc. The `anthropic/` prefix is stripped before hitting the SDK.

## Fallback chain

Every provider respects `config.fallbacks`. Each attempt uses the same provider instance but a different model id:

```ts
provider: { name: 'bedrock' },
model: 'amazon-bedrock/us.anthropic.claude-opus-4-7',
fallbacks: [
  'amazon-bedrock/global.anthropic.claude-sonnet-4-6',
  'amazon-bedrock/us.anthropic.claude-opus-4-6-v1',
  'amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
],
```

On per-attempt timeout (`provider.timeoutMs`, default 180s) or SDK-thrown error, the next model tries. Only when every chain entry fails does the turn error out.

Cross-provider fallback (e.g. Bedrock → Anthropic API on the same turn) is not currently supported — the provider instance can't be swapped mid-turn. If you need this, wrap both providers in a meta-provider — open a discussion first.

## Adding a new provider

Template: `packages/providers/src/bedrock/index.ts` (300 lines, mostly conversion glue).

Minimum to PR:

1. New file `packages/providers/src/<yourname>/index.ts`:

   ```ts
   import type { Provider, StreamChunk, TurnRequest } from '@postline/core';

   export class YourProvider implements Provider {
     readonly name = 'yourname';

     async *stream(req: TurnRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
       // 1. convertMessages(req.messages) → your SDK's shape
       // 2. call your SDK's streaming endpoint
       // 3. translate each event to StreamChunk
       //    - text_delta: running text
       //    - tool_use_end: completed tool use with parsed input
       //    - done: stopReason in { stop | tool_use | max_tokens | error }
     }
   }
   ```

2. Extend `ProviderSpec` in `packages/providers/src/registry.ts`:

   ```ts
   | { name: 'yourname'; apiKey?: string; ... }
   ```

   Add the `case 'yourname':` branch to `createProvider`.

3. Update package.json exports + package.json dependencies.

4. Tests in `packages/providers/src/<yourname>/<yourname>.test.ts`:
   - `convertMessages` shapes for text / tool_use / tool_result / image
   - stop-reason mapping
   - model-id prefix stripping (if applicable)

5. README update under the **Providers** section.

Do **not** modify the `Provider` interface in `@postline/core`. If you believe new capabilities are needed (e.g. vision, tool use) that the current interface doesn't express, open a design discussion first. Cross-provider interface changes need alignment.

## Candidates the community is welcome to add

- **OpenRouter** — gateway for many models. Has an Anthropic-API-compatible endpoint, so the Anthropic provider with a custom `baseUrl` may already work.
- **阿里云百炼 / Moonshot / 火山方舟** — domestic Chinese cloud providers. Each has its own OpenAPI format.
- **Azure OpenAI** — Claude is not on Azure, but if Claude ever is, the patterns match Bedrock.
- **Ollama / local vLLM** — for fully self-hosted open-weights models. Note that you'll lose Claude-specific features (tool use may require translation to OpenAI function-call format).

File a discussion with a design sketch before starting — we want provider implementations that stay faithful to the `Provider` contract (especially tool-use parity). A bag-of-features provider is harder to maintain than a tight Claude-lookalike.
