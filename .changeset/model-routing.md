---
'@postline/config': minor
---

Add optional model-routing config that classifies inbound text per turn and routes trivial queries (greetings, short text under `trivialMaxChars`, no tool-trigger keywords) to a cheaper `smallModel` instead of the primary. ~10x cost saving for high-frequency trivial chat without affecting hard query quality.

Off by default (no behaviour change unless you opt in).

```ts
routing: {
  enabled: true,
  smallModel: 'amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',  // default
  trivialMaxChars: 50,                                                            // default
}
```

Classifier is intentionally conservative: any English action verb (`run`, `check`, `explain`, `search`, `fetch`, `read`, ...), Chinese intent verb (`跑`, `查`, `帮`, `解释`, `怎么`, ...), shell / path / URL token (`sudo`, `git `, `/home/`, `https://`, `\`\`\``), or multi-line input vetoes trivial classification and falls back to the primary model. Tunable knobs deliberately limited so config drift doesn't surface bad routing decisions silently.

Wiring: `@postline/cli`'s `cmd-feishu` calls `pickModel(cfg.model, inbound.text, cfg.routing)` per turn; emits `feishu_routing_small_model` log when the small model is picked. 14 unit tests cover trivial / non-trivial classification + routing config gating.
