# Architecture

## Four interfaces, four seams

```
 ┌──────────────────────────────────────────────────────────────┐
 │                       @postline/core                           │
 │                                                               │
 │   TurnLoop(Provider, Channel[], Tool[], Memory) → 24/7 agent  │
 │                                                               │
 │   ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
 │   │  Provider   │  │   Channel    │  │        Tool         │ │
 │   │  .stream()  │  │  .listen()   │  │  .run(args, ctx)    │ │
 │   │             │  │  .send()     │  │  risk: read|        │ │
 │   │             │  │              │  │        write|       │ │
 │   │             │  │              │  │        dangerous    │ │
 │   └─────────────┘  └──────────────┘  └─────────────────────┘ │
 │          │                │                      │           │
 └──────────┼────────────────┼──────────────────────┼───────────┘
            │                │                      │
 ┌──────────▼──────┐  ┌──────▼──────┐  ┌───────────▼───────────┐
 │ @postline/       │  │ @postline/   │  │ @postline/             │
 │ providers       │  │ adapters-   │  │ tools-builtin         │
 │ ├─ bedrock      │  │ feishu      │  │ ├─ bash               │
 │ ├─ anthropic    │  │ adapters-   │  │ ├─ fs                 │
 │ └─ openrouter   │  │ cli         │  │ ├─ github             │
 │                 │  │ (future     │  │ ├─ memory             │
 │                 │  │  slack/etc) │  │ ├─ openclaw-bridge    │
 │                 │  │             │  │ └─ web-fetch          │
 └─────────────────┘  └─────────────┘  └───────────────────────┘
                               │
                      ┌────────▼────────┐
                      │  @postline/cli   │   (entry: `postline`)
                      │  config loader  │
                      │  DI wiring      │
                      └─────────────────┘
```

## Turn loop (pseudo)

```
for each inbound message from any Channel:
  if not from allowlist user: reject or reply read-only

  thread = conversationId from channel
  history = store.loadHistory(thread)
  memory = memory.load()  // MEMORY.md as system prefix

  messages = [system(memory), ...history, user(msg)]

  loop:
    stream = provider.stream({messages, tools})
    chunks, toolCalls = collectStream(stream)
    if toolCalls is empty: break
    for call in toolCalls:
      if call.risk == 'dangerous': await approval(from user)
      result = await tool.run(call.args, ctx)
      messages.push(assistant(chunks, toolCalls))
      messages.push(tool_result(call.id, result))

  store.appendHistory(thread, messages[n:])
  channel.send(thread, finalAssistantText)
```

## Security layers

See `THREAT_MODEL.md`.

## Package responsibilities

| Package | Depends on | Purpose |
|---|---|---|
| `@postline/core` | — | Interfaces, turn loop, log, types |
| `@postline/providers` | `core` | Bedrock / Anthropic / OpenRouter |
| `@postline/adapters-feishu` | `core` | Feishu WebSocket listener + sender |
| `@postline/adapters-cli` | `core` | stdin/stdout REPL |
| `@postline/tools-builtin` | `core` | bash / fs / github / memory / openclaw-bridge / web-fetch |
| `@postline/cli` | everything | entry point, config, DI |
