import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolResult } from '@postline/core';

export interface OpenclawBridgeOptions {
  /** Gateway URL — default ws://localhost:18789 (works on EC2 local + Mac via SSM tunnel). */
  url?: string;
  /** Gateway auth token. Required. */
  token: string;
  /** Default session id used by openclaw_say. */
  defaultSessionId?: string;
  /** openclaw CLI binary, default 'openclaw'. */
  bin?: string;
  /** Call timeout in ms. Default 5 minutes. */
  timeoutMs?: number;
}

/**
 * Shell out to the `openclaw gateway call` CLI to talk to 虾晃.
 * Mirrors the logic we already prototyped in openclaw-bridge MCP shim.
 */
export function createOpenclawBridgeTools(opts: OpenclawBridgeOptions): Tool[] {
  const url = opts.url ?? 'ws://localhost:18789';
  const defaultSession = opts.defaultSessionId ?? 'cc-collab';
  const bin = opts.bin ?? 'openclaw';
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const token = opts.token;

  function call(method: string, params: Record<string, unknown>, expectFinal: boolean) {
    return runCli(
      [
        'gateway',
        'call',
        method,
        '--url',
        url,
        '--token',
        token,
        '--json',
        '--timeout',
        String(timeoutMs),
        '--params',
        JSON.stringify(params),
        ...(expectFinal ? ['--expect-final'] : []),
      ],
      { bin, timeoutMs: timeoutMs + 15_000 },
    );
  }

  const sayTool: Tool = {
    name: 'openclaw_say',
    description:
      'Send a message to 虾晃 (openclaw agent on EC2) and wait for his reply. Use for three-way collab with C様.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        session_id: { type: 'string', description: `default "${defaultSession}"` },
      },
      required: ['message'],
      additionalProperties: false,
    },
    async run(args, _ctx): Promise<ToolResult> {
      try {
        const out = await call(
          'agent',
          {
            sessionId: typeof args.session_id === 'string' ? args.session_id : defaultSession,
            message: typeof args.message === 'string' ? args.message : '',
            idempotencyKey: `cc-${randomUUID()}`,
          },
          true,
        );
        const parsed = parseJson(out);
        const fr = (parsed as { result?: { finalResult?: Record<string, unknown> } })?.result
          ?.finalResult as
          | { finalAssistantVisibleText?: string; executionTrace?: { winnerModel?: string } }
          | undefined;
        const reply = fr?.finalAssistantVisibleText ?? '(empty)';
        const model = fr?.executionTrace?.winnerModel;
        return { content: `🦐 ${reply}${model ? `\n[model=${model}]` : ''}`, meta: { model } };
      } catch (e) {
        return { content: `ERROR: ${(e as Error).message}`, isError: true };
      }
    },
  };

  const healthTool: Tool = {
    name: 'openclaw_health',
    description: '虾晃 gateway health probe: event loop, plugins, channels.',
    risk: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const out = await call('health', {}, false);
        return { content: out.slice(0, 4000) };
      } catch (e) {
        return { content: `ERROR: ${(e as Error).message}`, isError: true };
      }
    },
  };

  const cronListTool: Tool = {
    name: 'openclaw_cron_list',
    description: 'List 虾晃 cron jobs (read-only).',
    risk: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const out = await call('cron.list', {}, false);
        return { content: out.slice(0, 8000) };
      } catch (e) {
        return { content: `ERROR: ${(e as Error).message}`, isError: true };
      }
    },
  };

  return [sayTool, healthTool, cronListTool];
}

function runCli(args: string[], opts: { bin: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    // The openclaw CLI is a .mjs with a `#!/usr/bin/env node` shebang.
    // Under systemd our PATH doesn't include nvm's bin dir, so `env node`
    // fails with "node: No such file or directory" (exit 127). We fix it by
    // prepending the directory of the current node binary to PATH for the
    // child — works whether bin is /home/ubuntu/.nvm/.../openclaw or just 'openclaw'.
    const nodeDir = process.execPath.replace(/\/[^/]+$/, '');
    const childEnv = {
      ...process.env,
      PATH: `${nodeDir}:${process.env.PATH ?? ''}`,
    };
    const child = spawn(opts.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`openclaw CLI timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`openclaw exited ${code}: ${err.trim() || out.trim()}`));
      else resolve(out);
    });
  });
}

function parseJson(s: string): unknown {
  const i = s.indexOf('{');
  if (i < 0) throw new Error('no JSON in openclaw output');
  return JSON.parse(s.slice(i));
}
