# syntax=docker/dockerfile:1.7

# postline runs as a 24/7 long-poll daemon (Lark.WSClient outbound).
# No HTTP server; no exposed port.
#
# Two-stage build: builder compiles the workspace, runner ships only the
# runtime artefacts + production deps.

# ---------- builder ----------
FROM node:22-alpine AS builder

# pnpm via corepack (no global installs, version pinned in package.json).
RUN corepack enable

# CI=true is a no-op here in practice (husky 9 already exits 0 when .git is
# missing), but keep both stages aligned so future install steps that read
# the flag behave identically. Real load-bearing copy is in the runner.
ENV CI=true

WORKDIR /app

# Copy lockfile + workspace manifests first so the dep layer caches across
# source-only edits. The `**/package.json` glob carries individual package
# manifests too; everything else is added in the next layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages

# Frozen-lockfile install + workspace build. Builder image keeps dev deps.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
RUN pnpm -r build

# ---------- runner ----------
FROM node:22-alpine AS runner

# git is needed at runtime for memory dir version control and is also
# required by `postline doctor`. node:22-alpine does not ship git.
RUN apk add --no-cache git

# Same corepack so we can run pnpm prune for the final layer.
RUN corepack enable

# CI=true makes pnpm skip the interactive "remove node_modules" confirm
# triggered by `pnpm install --prod` after we copy the builder's full
# node_modules tree. Without it: ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
# Multi-stage ENV doesn't inherit, so this must be set per stage.
ENV CI=true

# Run as non-root. node:22-alpine ships with a `node` user (uid 1000).
WORKDIR /app

# Copy built workspace from builder; then prune to production deps only.
# The pnpm store lives on a buildkit cache mount, so it never bakes into
# the final image — no need for a manual `rm` (which fails with "Resource
# busy" on the mount target).
COPY --from=builder /app /app
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts

# Memory dir is bind-mounted at runtime (see docker-compose.yml). State dir
# holds runtime scratch (e.g. the ws-state liveness tick) and is *not*
# bind-mounted — it lives inside the container's writable layer.
RUN mkdir -p /data/memory /data/state && chown -R node:node /app /data
USER node

# Default config location: a host-mounted postline.config.ts at /app/postline.config.ts
# falls through to env-only mode (see ../.env.example).
ENV CC_MEMORY_DIR=/data/memory \
    CC_STATE_DIR=/data/state \
    NODE_ENV=production

# Strict liveness probe: `postline doctor --strict` fails when the feishu
# WSClient has not delivered a tick within 90s. The adapter writes a tick
# on every dispatched event and from a 30s keep-alive timer driven by the
# SDK's connection-state callbacks, so a healthy container ticks in
# steady state and a stalled ws fails over within two interval windows.
#
# `start_period` is generous (120s) because the WS handshake + auth round
# trip can take 10-30s on cold container boot, and we don't want a slow
# network on the host to cause healthcheck-induced restart loops.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD node packages/cli/dist/bin.js doctor --strict || exit 1

# Default command: start the feishu adapter (long-poll outbound).
CMD ["node", "packages/cli/dist/bin.js", "feishu"]
