import { afterEach, describe, expect, it, vi } from 'vitest';
import { __isBlockedForTest, createWebFetchTool } from './web-fetch.js';

describe('web-fetch redirect re-validation (SSRF, audit 2026-06-17)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const ctx = { signal: new AbortController().signal } as unknown as Parameters<
    ReturnType<typeof createWebFetchTool>['run']
  >[1];

  it('blocks a redirect that points at IMDS (169.254.169.254)', async () => {
    // First hop: a public URL returns 302 → metadata endpoint. With manual
    // redirect handling each hop is re-validated, so the second host is caught.
    globalThis.fetch = (async (input: URL | string) => {
      const url = String(input);
      if (url.includes('169.254.169.254')) {
        throw new Error('should never fetch the metadata endpoint');
      }
      return {
        status: 302,
        headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
        body: null,
        ok: false,
      } as unknown as Response;
      // biome-ignore lint/suspicious/noExplicitAny: test fetch stub
    }) as any;

    const tool = createWebFetchTool();
    const res = await tool.run({ url: 'https://evil.example.com/redir' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/redirect to blocked host 169\.254\.169\.254/);
  });

  it('follows a redirect to another public host normally', async () => {
    let hops = 0;
    globalThis.fetch = (async (input: URL | string) => {
      const url = String(input);
      hops++;
      if (url.includes('start.example.com')) {
        return {
          status: 301,
          headers: new Headers({ location: 'https://final.example.com/page' }),
          body: null,
          ok: false,
        } as unknown as Response;
      }
      return {
        status: 200,
        headers: new Headers(),
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('hello'));
            c.close();
          },
        }),
      } as unknown as Response;
      // biome-ignore lint/suspicious/noExplicitAny: test fetch stub
    }) as any;

    const tool = createWebFetchTool();
    const res = await tool.run({ url: 'https://start.example.com/x' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('hello');
    expect(res.content).toContain('final.example.com');
    expect(hops).toBe(2);
  });
});

describe('web-fetch host policy', () => {
  const deny = ['localhost', '127.0.0.1', '169.254.169.254', '.internal'];
  it('blocks localhost', () => {
    expect(__isBlockedForTest('localhost', deny)).toBe(true);
  });
  it('blocks IMDS metadata', () => {
    expect(__isBlockedForTest('169.254.169.254', deny)).toBe(true);
  });
  it('blocks .internal suffix', () => {
    expect(__isBlockedForTest('foo.internal', deny)).toBe(true);
  });
  it('blocks RFC1918', () => {
    expect(__isBlockedForTest('10.0.0.5', deny)).toBe(true);
    expect(__isBlockedForTest('192.168.1.1', deny)).toBe(true);
    expect(__isBlockedForTest('172.16.0.1', deny)).toBe(true);
  });
  it('allows public hostnames', () => {
    expect(__isBlockedForTest('api.github.com', deny)).toBe(false);
    expect(__isBlockedForTest('example.com', deny)).toBe(false);
    expect(__isBlockedForTest('8.8.8.8', deny)).toBe(false);
  });
  it('allows CGNAT block is treated as private (carrier-grade)', () => {
    expect(__isBlockedForTest('100.64.0.1', deny)).toBe(true);
  });
});
