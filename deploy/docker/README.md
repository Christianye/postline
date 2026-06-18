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

The container's `HEALTHCHECK` runs `postline doctor --strict` every 60s. In addition to the basic env / memory / config checks, `--strict` reads a liveness tick the feishu adapter writes every 30s while the WSClient is connected (and on every dispatched event). If no tick lands within 90s, the check fails — Docker then restarts the container under `restart: unless-stopped`.

The `start_period` is 120s so a slow ws handshake on cold boot doesn't trigger a restart loop.

Manual checks:

```bash
docker compose exec postline node packages/cli/dist/bin.js doctor          # lenient — warns on missing tick
docker compose exec postline node packages/cli/dist/bin.js doctor --strict # what HEALTHCHECK runs
docker compose exec postline node packages/cli/dist/bin.js stats
```

## Dispatching to a cc-worker

The container runs the **bridge** (and, if you leave `embeddedLlm` on, a local
model for trivial replies). It does **not** run a `cc-worker` — workers run
wherever your repos + Claude Code live (your laptop, another box), and register
back to the bridge's doorbell. This split is deliberate: the bridge carries
bytes, the worker does the work.

To wire up dispatch:

1. **Enable the doorbell in config** (`doorbell.enabled = true`, a `secret`).
   In the container it binds `127.0.0.1:9999` — reach it from a worker host
   over an SSM/SSH tunnel (don't expose it publicly):

   ```bash
   # on the worker host, forward the bridge's loopback doorbell to localhost
   ssh -N -L 9999:127.0.0.1:9999 <bridge-host>     # or AWS SSM port-forward
   ```

2. **Start a worker** on the repo host:

   ```bash
   export CC_DOORBELL_URL=http://localhost:9999
   export CC_DOORBELL_SECRET=<same as the bridge's doorbell.secret>
   cd /path/to/your/repo
   postline cc-worker start
   ```

3. **Verify** from anywhere with the same env:

   ```bash
   postline doctor    # → "doorbell up at … , 1 worker(s) registered"
   ```

Then `!pl@<repo> …` in your IM dispatches to that worker. See
[`../../docs/QUICKSTART.md`](../../docs/QUICKSTART.md) for the full loop and
[`../../docs/cc-worker.md`](../../docs/cc-worker.md) for the worker in depth.

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
