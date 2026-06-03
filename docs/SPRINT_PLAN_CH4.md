# 第 4 章 · 搬家 — 4 周 sprint pack

> **Owner**: mac CC (per `project_postline_story.md` Part 6 + `protocol_cc_division.md` §2).
> **Status**: v1 draft — pending ec2 CC review.
> **Source story**: `project_postline_story.md` 第 4 章. Re-read 之前先回那份 doc 确认章节意图没漂.

---

## Goal (来自 story doc)

> 老张一键部署到 fly.io，3 分钟后飞书上多了个 bot，第一句话是自我介绍 + 邀请磨合。

具体落到 acceptance：

- **5 分钟** 从 `git clone` 到 `@bot 你好` 收得到回信。
- **第一次 @bot** 不是 mute 等指令，而是 bot 主动自我介绍 + 引导 1 个磨合问题（"我该怎么称呼你？"）。
- **改名 / 配置 persona** 用对话或 skill 完成，不开 wizard / 不暴露 yaml。

---

## Out of scope (本章不做)

| 不做 | 归属 |
|---|---|
| memory backup / restore / portability | 第 5 章 |
| multi-resident / multi-persona on one instance | 第 6 章 |
| agent-to-agent messaging 泛化 | 第 7 章 |
| memory 衰减 / 重要性加权 | 第 8 章 |
| skill marketplace | 永远不做（story doc Part 4） |
| telegram / slack adapter | 暂缓（"公开 demo bot" 才考虑） |
| 多 LLM provider 抽象（OpenAI / Gemini） | 暂缓 |

---

## Dependency 全景

**上游 (前置)**

- postline v0.4.0 base（caching / routing / daily-report 已 land）
- `project_postline_lark_user_oauth.md` 设计稿（user-OAuth feature，4 PR 拆分已就绪）
- `design_secret_provider.md` 抽象设计（env / SSM / fly 3 backend）

**下游 (本章 unblock)**

- 第 5 章 memory backup（搬家 ≠ 失忆，但搬家先 land）
- C-mirror-2 飞书自动化（`ec2 CC 自动 sync postline docs`，要 OAuth feature done）
- 公开 demo bot（story doc Part 3 并行启动，但要 ch4 部署模板才能站得起来）

**章内 PR 链**

```
PR-CH4-1 (docker-compose)
   └── PR-CH4-2 (fly launch)        ← 平行
   └── PR-CH4-3 (railway)           ← 平行
   └── PR-CH4-4 (memory seed)       ← W2 起点, 依赖 PR-CH4-1 镜像
        └── PR-CH4-5 (persona skill)
        └── PR-CH4-6 (config reload)
             └── PR-CH4-7 (first-contact 检测)
                  └── PR-CH4-8 (1 question lazy onboarding)
                       └── PR-CH4-9 (onboarded flag)
                            └── PR-CH4-10 (DEPLOY.md)
                                 └── PR-CH4-11 (pre-flight checklist)
                                      └── PR-CH4-12 (release v0.5.0)
```

---

## SecretProvider 重合决策（已拍）

**方案 B**：OAuth feature 先 hardcode SSM ship；ch4 引入 SecretProvider 抽象后，OAuth retrofit。

理由：

- 本章 P0 是部署可达性，不是 secret 抽象层。
- OAuth feature 4 PR 跟 ch4 时间线平行（ec2 CC 那边能开），不应被 ch4 节奏阻塞。
- `design_secret_provider.md` 提到的 3-PR 拆分（接口 / SSM 实现 / OAuth 接入）落到 ch5 或 ch4.1 不影响"搬家"叙事。

**ch4 secret 处理临时方案**：

- docker-compose / railway → env file
- fly.io → `flyctl secrets set`
- 文档明写 "v0.5.0 这步是手动；下个 minor 引入 SecretProvider 后透明化"

---

## Sprint 1 (W1) · 部署模板骨架

> **目标**：`docker compose up` 能跑通飞书 bot；fly / railway 各一份模板能起。

### PR-CH4-1 · docker-compose 模板 + .env.example

- 新增 `deploy/docker-compose.yml` (postline + 持久化 memory volume)
- 新增 `deploy/.env.example` (FEISHU_APP_ID / FEISHU_APP_SECRET / VERIFICATION_TOKEN / ENCRYPT_KEY / ANTHROPIC_API_KEY)
- README "Quick start" 段落补 `docker compose` 路径
- **Acceptance**：clone repo → `cp .env.example .env` 填值 → `docker compose up -d` → 飞书 @bot 收到 hello 回应（≤ 30s 冷启动）。

### PR-CH4-2 · fly.io launch.toml

- 新增 `deploy/fly.toml` + `deploy/fly.dockerfile` (postline + alpine + memory volume mount)
- 文档 step：`flyctl launch --copy-config --no-deploy` → `flyctl secrets set ...` → `flyctl deploy`
- **Acceptance**：fresh fly account → `flyctl launch` → 公网 webhook URL → 在飞书后台填 webhook → @bot 工作。
- **Risk**：fly.io free tier auto-stop after 0 traffic；首次响应 cold start ~3-5s。Doc 里明写"第一条消息可能慢"。

### PR-CH4-3 · railway 模板

- 新增 `deploy/railway.json` 或 README railway button + Dockerfile 复用 fly 那个
- **Acceptance**：railway "deploy from GitHub" → 一次成功 → 飞书 @bot 工作。

### Sprint 1 风险

- 三家平台 webhook 公网路径配置不一样；先在 PR-CH4-1 里把 webhook 健康检查接口固化（`GET /health`），后两 PR 复用。
- 飞书 admin 后台 webhook URL 配置需要人工，不能脚本自动 — 这块进 W4 pre-flight checklist。

---

## Sprint 2 (W2) · memory bootstrap + persona scaffold

> **目标**：新装实例自带 CC persona seed；用户能改名 / 调性格。

### PR-CH4-4 · memory seed

- `packages/postline-core/src/bootstrap/seed/` 下新增：
  - `working_style.md` (CC 默认人格：先方案后代码 / dangerous 动作先声明 / 中文回复...)
  - `persona.md.template` (name / tone / role / domain — placeholder)
  - `MEMORY.md.template` (空 index)
- 启动逻辑：memory 目录为空 / 不存在 → 拷贝 seed → 写 `bootstrap_at: <iso>` 元数据
- **Acceptance**：删本地 memory dir → 重启 postline → memory dir 自动出现 + 上述 3 个文件 + bootstrap_at 戳上。
- **Dependency**：PR-CH4-1 完成（镜像里要 bake 进 seed）。

### PR-CH4-5 · persona skill

- 新增 skill：`/rename <new-name>`、`/persona set tone <text>`、`/persona show`
- 写入 `persona.md` 而非配置文件
- **Acceptance**：飞书 @bot `/rename Foo` → `persona.md` 里 `name: Foo` 落地 → 下次回复用 Foo 自称。

### PR-CH4-6 · 配置 reload (无 daemon 重启)

- memory 文件 fs-watch（chokidar 或 systemd path 监听 — 三平台都用 chokidar 省事）
- 监测到改动 → 下一 turn 重新读 memory，不走重启路径
- **Acceptance**：手改 `persona.md` tone → 下条消息体感变化（不重启）。

### Sprint 2 风险

- **persona schema 跟第 5 章 memory portability 撞**：W2 这版 schema 必须在 5 章设计时被尊重 / 平滑迁移。落 ADR `docs/adr/0001-persona-schema.md` 占坑。
- skill UX 写错容易让用户觉得在配置文件 — `/persona show` 输出语气要"住户口吻"，不是 yaml dump。

---

## Sprint 3 (W3) · onboarding flow

> **目标**：bot 第一次被 @ 时自然引导，**只问 1 个问题**（称呼），后续问题 lazy 触发。

### PR-CH4-7 · first-contact 检测

- memory 里 `onboarded_at: null` 或缺失 → first contact
- bot 主动自我介绍 + 邀请：`"我刚搬来。我该怎么称呼你？"`
- **Acceptance**：fresh 实例 + 首次 @bot → 收到自我介绍而非任务执行。

### PR-CH4-8 · 1-question lazy onboarding

- W3 不堆 3-5 轮问题（用户体感 = 填表）
- 第一问：称呼 → 答完写 `user_address: <name>` 进 working_style
- 后续问题（技术栈 / 工作风格）由 bot 在自然对话中**碰到歧义时**问 — 不主动堆
- **Acceptance**：答完称呼 → 下条消息 bot 用新称呼，不再追问。

### PR-CH4-9 · onboarded flag

- 答完 first-contact 问题 → `onboarded_at: <iso>` 写入
- 后续启动 / 重连 → 跳过 first-contact 路径
- **Acceptance**：onboarded 后再 @bot → 直接进任务态，不重播自我介绍。

### Sprint 3 风险

- bot 自我介绍措辞要 C様 + ec2 CC 把关（"住户"叙事不能写成机器播报）
- "lazy 后续问题" 的触发条件要明确，否则 bot 永远不主动学新事 — 设计 spec 写到 ADR `docs/adr/0002-onboarding-lazy-trigger.md`

---

## Sprint 4 (W4) · 收尾 + dogfood + ship

> **目标**：老张能用；postline v0.5.0 release。

### PR-CH4-10 · DEPLOY.md

- 三平台 step-by-step（docker-compose / fly / railway）
- 每平台 30 行内可读完
- 从 0 到 first hello 时间预估写明

### PR-CH4-11 · pre-flight checklist

- `docs/PREFLIGHT.md`：env / OAuth / webhook URL / 飞书 admin 后台配置 / 必要 LLM key
- `npm run preflight` 脚本（可选 — 时间够再做）扫一遍 env，给红绿灯输出

### PR-CH4-12 · release v0.5.0

- changeset：feat (deploy templates) + feat (memory bootstrap) + feat (persona) + feat (onboarding)
- bump → 0.5.0
- CHANGELOG section 标题：`第 4 章 · 搬家`
- **Acceptance**：npm publish + GitHub release 同步；老张拿到 release 链接能跑通 5 分钟体验。

### Sprint 4 风险

- 老张实际 dogfood 反馈来不及 incorporate → 留给 ch4.1 patch
- changesets 包之间版本对齐（postline-core / postline-cli / postline-feishu）— 现行 monorepo 版本策略需要在 W4 第一天 review，不要到 release 当天才发现 bump 错位

---

## Risk surface (4 周塞不下 / 需要 C様 拍)

| 项 | 状态 | 决策 |
|---|---|---|
| SecretProvider 抽象 | **不进 ch4** | 方案 B 已定 |
| OAuth feature 4 PR | **平行 (ec2 CC)** | 不阻塞 ch4 P0 |
| 公开 demo bot | **不进 ch4 sprint** | W4 release 后用部署模板自动起一个，单独 issue |
| `npm run preflight` 脚本 | **stretch goal** | 时间不够则 docs only，preflight 自动化挪到 ch4.1 |
| 老张实际 dogfood 反馈 | **超出本章 boundary** | 留 ch4.1 patch；ch5 (memory) 也可吸收一部分 |
| 飞书 admin 后台不能脚本化 | **接受** | DEPLOY.md 写明，不上自动化 |

---

## Acceptance for B 自身（这份 doc 的交付定义）

- [x] 4 sprint × 3-5 PR 排好
- [x] PR 间 dependency 显式（章内 PR 链 + Sprint 风险段）
- [x] SecretProvider 重合决策已拍并写明
- [x] 4 周塞不下的 risk 全部 surface（不硬塞）
- [ ] ec2 CC review pass（mailbox normal 回信）— pending
- [ ] 解锁 C-mirror-1（飞书 push README + 这份 sprint pack）— pending B+review

---

## Changelog

- **2026-06-03 v1**: 初稿。SecretProvider 选 B；onboarding 选"1 问 + lazy 后续"；release 选 v0.5.0。
