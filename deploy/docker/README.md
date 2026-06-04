# Deploy — Docker compose

One-container postline deployment. Use this when:

- You don't want a permanent VM (this is the path used on fly.io / railway / Render too — same Dockerfile)
- You want everything (build / runtime / persistent memory) in a single `docker compose up`
- You're trialling postline on a laptop / NAS / home server

For 24/7 systemd-on-EC2 deployments, see [`../README.md`](../README.md) (the legacy systemd flavour).

## Why no port mapping?

`postline-cli feishu` opens a `Lark.WSClient` long-poll connection **outbound** to Feishu. There is no inbound HTTP server, no webhook URL, no exposed port. The container only needs egress internet access.

## Prerequisites

- Docker 24+ with Compose v2 (`docker compose ...`)
- A Feishu自建应用 with 事件订阅 set to **长连接 (WSClient)** mode (NOT webhook)
- LLM credentials: AWS profile/keys for Bedrock, or `ANTHROPIC_API_KEY` for Anthropic API

## Quick start

```bash
git clone https://github.com/Christianye/postline.git
cd postline/deploy/docker
cp .env.example .env
# Edit .env — fill in CC_FEISHU_APP_ID + CC_FEISHU_APP_SECRET +
#                  AWS_REGION (Bedrock) or ANTHROPIC_API_KEY (Anthropic).
docker compose up -d
docker compose logs -f
```

You should see lines like `feishu_ws_connected` and `tools_loaded` within ~30s. Then `@bot 你好` in any Feishu group the bot has joined → bot replies.

## Health and restarts

The container's `HEALTHCHECK` runs `postline doctor` every 60s — a read-only command that exits non-zero on missing creds, unreadable memory, or broken builds. Combined with `restart: unless-stopped`, Docker auto-restarts unhealthy containers.

**Caveat (v0.5.0)**: `doctor` does not yet inspect WebSocket liveness. A stuck WSClient (network blip the adapter didn't catch, fly idle-stop, etc.) currently won't fail the healthcheck. PR-CH4-1b adds `doctor --strict` with a `feishu-ws-last-tick.json` probe — at which point this Dockerfile will switch to `doctor --strict`.

Manual checks:

```bash
docker compose exec postline node packages/cli/dist/bin.js doctor
docker compose exec postline node packages/cli/dist/bin.js stats
```

## Persistent memory

`./memory` on the host is bind-mounted to `/data/memory` in the container. Its contents survive image rebuilds. For backup, snapshot or git-push the host directory the same way you would treat any agent state.

If you want memory in a Docker named volume instead, replace the `volumes:` line in `docker-compose.yml`:

```yaml
volumes:
  - postline-memory:/data/memory

volumes:
  postline-memory:
```

## Updating

```bash
git pull
docker compose build --pull
docker compose up -d
```

The build cache reuses node_modules across source-only edits; full rebuild happens when `pnpm-lock.yaml` changes.

## Troubleshooting

**`postline doctor` exits non-zero on first boot** — the container is technically unhealthy until you've populated `.env`. Check `docker compose logs postline` to see which env var is missing.

**Bot connects but doesn't reply** — verify the bot's openId is in `CC_ALLOWLIST_OPEN_IDS` (or remove the allowlist for read-only mode), and that 事件订阅 is enabled on the Feishu app.

**Memory not persisting** — confirm the bind-mount target exists on host and is writable: `ls -la deploy/docker/memory`.
