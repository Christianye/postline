import { randomUUID } from 'node:crypto';
import { createFeishuChannel, type FeishuChannel } from '@postline/adapters-feishu';
import {
  createLogger,
  createPendingActions,
  runTurn,
  type ImagePart,
  type InboundMessage,
  type OutboundMessage,
  type PendingActions,
  type Tool,
  type TurnExtras,
} from '@postline/core';
import { createProvider } from '@postline/providers';
import {
  createBashReadTool,
  createBashTool,
  createEchoTool,
  createFsTools,
  createGithubTools,
  createLarkDocsTools,
  createMemoryTools,
  createOpenclawBridgeTools,
  createWebFetchTool,
} from '@postline/tools-builtin';
import { loadConfig } from './config.js';
import { providerSpecFromConfig } from './provider-spec.js';
import { createFsMemory } from './memory-fs.js';
import { createMemoryHistory } from './history-memory.js';

export async function runFeishu(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.logLevel });

  const appId = process.env.CC_FEISHU_APP_ID ?? '';
  const appSecret = process.env.CC_FEISHU_APP_SECRET ?? '';
  if (!appId || !appSecret) {
    process.stderr.write(
      'missing CC_FEISHU_APP_ID / CC_FEISHU_APP_SECRET. Put them in ~/.cc-dev/.env or ~/.cc/env.\n',
    );
    process.exit(2);
  }

  const provider = createProvider(providerSpecFromConfig(cfg), {
    log,
    fallbacks: cfg.fallbacks,
  });
  const memory = createFsMemory(cfg.memoryDir);
  const history = createMemoryHistory();
  const pending: PendingActions = createPendingActions();

  // -- Tool assembly ------------------------------------------------------
  const tools = new Map<string, Tool>();
  for (const t of [
    createEchoTool(),
    createWebFetchTool(),
    ...createFsTools({
      readAllow: [cfg.memoryDir, '/tmp'],
      writeAllow: [cfg.memoryDir, '/tmp'],
    }),
    ...createMemoryTools({ dir: cfg.memoryDir, gitPush: true }),
    ...createGithubTools(),
    ...createLarkDocsTools({ appId, appSecret }),
    createBashReadTool({ timeoutMs: 30_000 }),
    createBashTool({ risk: 'dangerous', timeoutMs: 30_000 }),
  ]) {
    tools.set(t.name, t);
  }
  // Optional openclaw bridge — only if an openclaw token is configured.
  if (process.env.CC_OPENCLAW_TOKEN) {
    for (const t of createOpenclawBridgeTools({
      token: process.env.CC_OPENCLAW_TOKEN,
      url: process.env.CC_OPENCLAW_URL ?? 'ws://localhost:18789',
      defaultSessionId: process.env.CC_OPENCLAW_SESSION ?? 'cc-collab',
      // Under systemd our $PATH doesn't include nvm's bin dir, so spawn('openclaw')
      // falls through to `env node` in the openclaw shebang and fails with exit 127.
      // Explicit path via env override avoids touching system files.
      ...(process.env.CC_OPENCLAW_BIN ? { bin: process.env.CC_OPENCLAW_BIN } : {}),
    })) {
      tools.set(t.name, t);
    }
  }
  log.info({ toolCount: tools.size, tools: [...tools.keys()] }, 'cc_tools_loaded');

  const channel = createFeishuChannel({
    appId,
    appSecret,
    log,
    ...(process.env.CC_FEISHU_BOT_OPEN_ID
      ? { botOpenId: process.env.CC_FEISHU_BOT_OPEN_ID }
      : {}),
    requireMention: true,
  });

  // -- Approval gate: ask the user in the same chat, then wait up to 5min --
  async function approveDangerous(
    tool: Tool,
    args: Record<string, unknown>,
    ctx: { userId: string; conversationId: string },
  ): Promise<boolean> {
    const actionId = randomUUID().slice(0, 8);
    const preview = JSON.stringify(args).slice(0, 300);
    const message = [
      `🦞 **Approval required** for ${tool.name} (dangerous)`,
      '',
      `args: \`${preview}\``,
      '',
      `Reply with \`/approve ${actionId}\` within 5 minutes, or \`/deny ${actionId}\`.`,
    ].join('\n');
    try {
      await channel.send({ conversationId: ctx.conversationId, text: message });
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'approval_prompt_failed');
      return false;
    }
    return pending.create({
      id: actionId,
      tool: tool.name,
      args,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      ttlMs: 5 * 60_000,
    });
  }

  log.info({ allowlist: [...cfg.allowlist] }, 'feishu_start');

  const stop = channel.listen((inbound: InboundMessage) => {
    log.info(
      {
        turn: inbound.id,
        from: inbound.userId,
        chat: inbound.conversationId,
        textLen: inbound.text.length,
      },
      'feishu_inbound',
    );

    // Check for slash commands FIRST — they bypass the turn loop entirely.
    const slash = parseSlash(inbound.text);
    if (slash?.cmd === 'approve' || slash?.cmd === 'deny') {
      void handleSlash(inbound, slash, pending, channel, log);
      return;
    }

    void (async () => {
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 360_000);
      try {
        const extras: TurnExtras = {};
        const imageKeys = (inbound.meta?.imageKeys as readonly string[] | undefined) ?? [];
        const messageId = inbound.meta?.messageId as string | undefined;
        if (imageKeys.length > 0 && messageId) {
          const images = await downloadImagesForTurn(
            channel,
            messageId,
            imageKeys,
            log,
          );
          if (images.length > 0) extras.images = images;
        }

        const reply = await runTurn(
          inbound,
          {
            model: cfg.model,
            maxIterations: 8,
            allowlist: cfg.allowlist,
            historyLimit: 40,
            log,
            approveDangerous: (tool, args, toolCtx) => approveDangerous(tool, args, toolCtx),
          },
          { provider, tools, memory, history },
          ac.signal,
          extras,
        );
        log.info({ turn: inbound.id, replyLen: reply.length }, 'feishu_turn_ok');
        if (!reply) return;
        const out: OutboundMessage = {
          conversationId: inbound.conversationId,
          text: reply,
          meta: { replyToMessageId: inbound.meta?.messageId },
        };
        await channel.send(out);
        log.info({ turn: inbound.id }, 'feishu_sent');
      } catch (e) {
        log.error({ err: (e as Error).message, turn: inbound.id }, 'feishu_turn_error');
      } finally {
        clearTimeout(timeout);
      }
    })();
  });

  const shutdown = async () => {
    log.info({}, 'feishu_shutdown');
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise<void>(() => {});
}

interface Slash {
  cmd: string;
  arg: string;
}

function parseSlash(text: string): Slash | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const m = /^\/(\w+)(?:\s+(.+))?$/u.exec(trimmed);
  if (!m) return null;
  return { cmd: m[1] ?? '', arg: (m[2] ?? '').trim() };
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
const MAX_IMAGES_PER_TURN = 5;

async function downloadImagesForTurn(
  channel: FeishuChannel,
  messageId: string,
  imageKeys: readonly string[],
  log: ReturnType<typeof createLogger>,
): Promise<ImagePart[]> {
  const take = imageKeys.slice(0, MAX_IMAGES_PER_TURN);
  if (take.length < imageKeys.length) {
    log.warn(
      { total: imageKeys.length, taken: take.length },
      'feishu_image_limit_exceeded_truncating',
    );
  }
  const out: ImagePart[] = [];
  for (const key of take) {
    try {
      const { bytes, mimeType } = await channel.downloadImage(messageId, key);
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        log.warn(
          { key, bytes: bytes.byteLength, max: MAX_IMAGE_BYTES },
          'feishu_image_too_large_skipped',
        );
        continue;
      }
      out.push({ type: 'image', data: bytes.toString('base64'), mimeType });
      log.info({ key, bytes: bytes.byteLength, mimeType }, 'feishu_image_downloaded');
    } catch (e) {
      log.warn({ key, err: (e as Error).message }, 'feishu_image_download_failed');
    }
  }
  return out;
}

async function handleSlash(
  inbound: InboundMessage,
  slash: Slash,
  pending: PendingActions,
  channel: {
    send: (m: OutboundMessage) => Promise<void>;
  },
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const id = slash.arg;
  if (!id) {
    await channel.send({
      conversationId: inbound.conversationId,
      text: `usage: /${slash.cmd} <action-id>`,
    });
    return;
  }
  const ok =
    slash.cmd === 'approve' ? pending.approve(id) : slash.cmd === 'deny' ? pending.deny(id) : false;
  const reply = ok
    ? `✅ ${slash.cmd}d action ${id}`
    : `⚠️ no pending action with id ${id} (expired or never existed)`;
  await channel.send({ conversationId: inbound.conversationId, text: reply });
  log.info({ cmd: slash.cmd, actionId: id, ok }, 'slash_handled');
}
