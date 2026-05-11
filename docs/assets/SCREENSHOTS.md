# Screenshot capture guide

> **Status**: screenshots deferred — the README currently describes the three scenarios in text only. Once we have shots captured (and redacted for workspace / tenant info), add them to `docs/assets/` under the filenames below and swap the "What it looks like" section back to `![...](docs/assets/...)` references.

Three images go in `docs/assets/`. Suggested filenames match the README image refs when we re-enable them. All dimensions are suggestions — GitHub will render anything; 720-1000px wide is a sweet spot.

---

## 1. `chat-repl.png` — local REPL against your provider

**Setup**: have a valid `postline.config.ts` and `ANTHROPIC_API_KEY` (or AWS) set.

**Command**:

```bash
pnpm chat
```

**Prompt to type**:

```
run git log --oneline -5 on this repo and tell me what changed
```

**What the screenshot should show**:

- The banner line: `postline chat — model=..., provider=..., tools=N`
- Your `you> ` prompt with the question
- The model's reasoning output: something like "I'll use bash_read to inspect..."
- The tool call result (5 commit lines)
- The model's summary: 2-3 sentences about what the commits do

**Crop**: from the banner to the end of the final summary. Hide your shell prompt before/after.

**Tip**: pick a repo with interesting commits — this one works (`postline` itself has short readable commit messages after the rename).

---

## 2. `feishu-dm.png` — interactive feishu reply

**Setup**: `pnpm start` running, bot added to a DM or a group. Your `allowlist.openIds` includes your own open_id (so write tools are enabled).

**Prompt to send the bot** (DM, or `@bot ...` in a group):

```
帮我看下这台机器的 hostname 和 uname -a，顺便告诉我 systemd 有没有 cc.service 在跑
```

**What the screenshot should show**:

- Your message bubble on the right
- The bot's reply bubble(s) on the left with:
  - A short preamble ("I'll check the hostname and systemctl state...")
  - Tool call hints (the framework logs these in-message as `→ bash_read(...)` — or shown as a preview in feishu)
  - The final answer: hostname line, kernel line, `cc.service: active (running)` or similar

**Crop**: bubble to bubble, 3-5 bubbles total. Blur/mask your real hostname if it's sensitive.

**Tip**: if your bot's avatar is the default, set a custom one in feishu admin — more memorable at a glance.

---

## 3. `lark-doc-read.png` — bot reading a feishu docx

**Setup**: you need a docx URL (`https://xxx.feishu.cn/docx/xxxxx`) that your bot's feishu app has read access to. Any small internal doc works.

**Prompt to send**:

```
这个文档讲了什么？给我 3 条总结
https://xxx.feishu.cn/docx/xxxxxxxxxxxxxxxxxxxx
```

**What the screenshot should show**:

- Your message with the URL visible
- The bot's reply with a numbered 3-bullet summary
- (Ideally) a hint that `lark_doc_read` was invoked — feishu rendering of our "→ tool:..." marker

**Crop**: user message + 1-2 bot bubbles. Mask the exact doc URL / title if the content is confidential.

**Tip**: pick a doc with clear sections — a launch plan, a design doc. Avoid screenshots-heavy docs (those become empty `[image]` placeholders).

---

## Re-creating screenshots after UI changes

If the screenshot drifts from reality (banner text, feishu UI updates), re-run the same prompts and replace the PNGs in place. README uses relative paths so nothing else needs to change.
