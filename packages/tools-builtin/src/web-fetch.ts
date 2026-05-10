import type { Tool, ToolContext, ToolResult } from '@postline/core';

export interface WebFetchToolOptions {
  /** Max bytes to return. Default 2 MB. */
  maxBytes?: number;
  /** Fetch timeout. Default 20s. */
  timeoutMs?: number;
  /**
   * Hostname deny-list (exact or suffix match). Defaults to common private ranges + metadata endpoints.
   * Empty string matches all to disable.
   */
  hostDeny?: readonly string[];
}

const DEFAULT_DENY: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254',
  '.internal',
  '.local',
  '.localhost',
];

function isBlocked(host: string, deny: readonly string[]): boolean {
  const h = host.toLowerCase();
  for (const pat of deny) {
    const p = pat.toLowerCase();
    if (p.startsWith('.') ? h.endsWith(p) : h === p) return true;
  }
  // Block RFC1918 + CGNAT IPs via textual check (good enough — DNS rebinding is Phase 2).
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.)/.test(h)) {
    return true;
  }
  // IPv6 loopback / link-local
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc00:') || h.startsWith('fd00:')) {
    return true;
  }
  return false;
}

export function createWebFetchTool(opts: WebFetchToolOptions = {}): Tool {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const deny = opts.hostDeny ?? DEFAULT_DENY;
  return {
    name: 'web_fetch',
    description: `HTTP GET a public URL. Response truncated to ${maxBytes} bytes, ${timeoutMs}ms timeout. Private/metadata hosts blocked.`,
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'https:// or http:// URL' },
        accept: {
          type: 'string',
          description: 'Optional Accept header, e.g. "application/json"',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const url = typeof args.url === 'string' ? args.url : '';
      const accept = typeof args.accept === 'string' ? args.accept : undefined;
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return { content: `ERROR: invalid URL: ${url}`, isError: true };
      }
      if (!(u.protocol === 'http:' || u.protocol === 'https:')) {
        return { content: `ERROR: only http/https supported`, isError: true };
      }
      if (isBlocked(u.hostname, deny)) {
        return { content: `ERROR: host ${u.hostname} is blocked`, isError: true };
      }
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const resp = await fetch(u, {
          method: 'GET',
          headers: {
            'User-Agent': 'postline/0.1',
            ...(accept ? { Accept: accept } : {}),
          },
          signal: ac.signal,
          redirect: 'follow',
        });
        const reader = resp.body?.getReader();
        if (!reader) return { content: `[${resp.status}] (empty body)`, meta: { status: resp.status } };
        const chunks: Uint8Array[] = [];
        let total = 0;
        let truncated = false;
        while (total < maxBytes) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            const remaining = maxBytes - total;
            if (value.byteLength > remaining) {
              chunks.push(value.subarray(0, remaining));
              total += remaining;
              truncated = true;
              break;
            }
            chunks.push(value);
            total += value.byteLength;
          }
        }
        try {
          await reader.cancel();
        } catch {}
        const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
        return {
          content: `[${resp.status} ${u.toString()}]\n${body}${truncated ? '\n[...truncated]' : ''}`,
          ...(resp.ok ? {} : { isError: true }),
          meta: { status: resp.status, bytes: total, truncated },
        };
      } catch (e) {
        return { content: `ERROR: ${(e as Error).message}`, isError: true };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

export { isBlocked as __isBlockedForTest };
