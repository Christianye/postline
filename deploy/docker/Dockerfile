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
COPY --from=builder /app /app
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --prod --frozen-lockfile --ignore-scripts \
    && pnpm store prune \
    && rm -rf /root/.local/share/pnpm

# Memory dir is bind-mounted at runtime (see docker-compose.yml). We create
# the mount point so the container starts cleanly even before the volume is
# attached for first-boot bootstrap.
RUN mkdir -p /data/memory && chown -R node:node /app /data
USER node

# Default config location: a host-mounted postline.config.ts at /app/postline.config.ts
# falls through to env-only mode (see ../.env.example).
ENV CC_MEMORY_DIR=/data/memory \
    NODE_ENV=production

# Weak liveness probe: `postline doctor` exits non-zero on missing deps /
# creds / unreadable memory dir, which catches container-level breakage.
# It does NOT detect a stuck WSClient — that requires the `--strict` flag
# planned in PR-CH4-1b (writes `feishu-ws-last-tick.json` from the adapter
# and fails when stale > 90s). Once shipped, switch to `doctor --strict`.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node packages/cli/dist/bin.js doctor || exit 1

# Default command: start the feishu adapter (long-poll outbound).
CMD ["node", "packages/cli/dist/bin.js", "feishu"]
