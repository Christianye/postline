# @postline/adapters-slack

## 0.7.0

### Patch Changes

- fix: slack dedup + backoff (#73)
- fix: route rejected `onEnvelope` to `onError` (#67)
- fix: prune terminal tasks off the queue (#66)

## 0.6.0

### Minor Changes

- 89e9967: feat(slack): @postline/adapters-slack — zero-dep Slack Socket Mode Channel

  New channel adapter (IM-axis third slot), implementing the core `Channel`
  interface plus the extended turn-runner surface Feishu/Telegram expose:

  - `socket.ts`: Socket Mode — `apps.connections.open` → WSS connect →
    ack each `events_api`/`interactive` envelope within 3s → reopen on
    `disconnect`/close with backoff. No inbound port (matches feishu WS /
    telegram long-poll).
  - `parse.ts`: Events API `message`/`app_mention` → `InboundMessage`;
    channel mention gating (`<@BOTID>` / app_mention), DMs always pass; bot
    messages + subtypes dropped; first-file extraction.
  - `split.ts`: `splitForSlack` (3500-char chunks).
  - `approval.ts`: Block Kit approve/deny buttons, `<verb>:<actionId>`
    button value, `block_actions` parse; mirrors the feishu/telegram 8-char
    actionId + TTL + `/approve` fallback.
  - `index.ts`: `createSlackChannel` — send / editText (chat.update) /
    sendText / sendApproval / resolveApproval / onAction / downloadFile /
    health.

  Zero-dependency: Web API via fetch, transport via the platform-native
  `WebSocket` (Node 22 global). App-level token (`xapp-…`) for the socket +
  bot token (`xoxb-…`) for Web API calls.

  Adapter unit; the `postline slack` CLI wiring is the follow-on (same D1
  hybrid split as telegram). 19 adapter tests.

### Patch Changes

- Updated dependencies [d8791cb]
- Updated dependencies [5040a61]
  - @postline/core@0.6.0
