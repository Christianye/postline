import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../types.js';
import {
  type DesignReviewPushOptions,
  formatPushMessage,
  isDesignReviewPr,
  startDesignReviewPushPoller,
} from './design-review-push.js';

function silentLogger(): Logger {
  const noop = () => {};
  // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub for tests
  const log: any = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  };
  log.child = () => log;
  return log as Logger;
}

describe('isDesignReviewPr', () => {
  it('matches when any file path starts with a watch prefix', () => {
    expect(
      isDesignReviewPr(
        [{ path: 'docs/designs/doorbell.md' }, { path: 'README.md' }],
        ['docs/designs/'],
      ),
    ).toBe(true);
  });

  it('returns false when no file matches', () => {
    expect(
      isDesignReviewPr([{ path: 'src/index.ts' }, { path: 'package.json' }], ['docs/designs/']),
    ).toBe(false);
  });

  it('honours multiple watch prefixes', () => {
    expect(isDesignReviewPr([{ path: 'rfcs/0001.md' }], ['docs/designs/', 'rfcs/'])).toBe(true);
  });

  it('returns false on empty file list', () => {
    expect(isDesignReviewPr([], ['docs/designs/'])).toBe(false);
  });
});

describe('formatPushMessage', () => {
  it('produces a one-line message with PR link and snippet', () => {
    const msg = formatPushMessage({
      prNumber: 38,
      prTitle: 'docs: postline reframe RFC',
      prUrl: 'https://github.com/Christianye/postline/pull/38',
      commentAuthor: 'Christianye',
      commentSnippet: 'looks good, lock RF1-RF8',
    });
    expect(msg).toContain('PR #38');
    expect(msg).toContain('@Christianye');
    expect(msg).toContain('https://github.com/Christianye/postline/pull/38');
    expect(msg).toContain('looks good, lock RF1-RF8');
    expect(msg.split('\n')).toHaveLength(1);
  });
});

describe('startDesignReviewPushPoller', () => {
  let tmp: string;
  let stateFile: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-design-push-'));
    stateFile = join(tmp, 'design-review-pushed.json');
    prevStateDir = process.env.CC_STATE_DIR;
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.CC_STATE_DIR;
    else process.env.CC_STATE_DIR = prevStateDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeOpts(over: Partial<DesignReviewPushOptions>): DesignReviewPushOptions {
    return {
      repo: 'Christianye/postline',
      watchPaths: ['docs/designs/'],
      pollIntervalMs: 1_000_000,
      receiverOpenId: 'ou_test',
      stateFilePath: stateFile,
      sendFeishuMessage: vi.fn(async () => {}),
      ghJson: vi.fn(async () => []) as never,
      log: silentLogger(),
      ...over,
    };
  }

  it('disabled toggle returns a no-op handle and never polls', async () => {
    const send = vi.fn(async () => {});
    const ghJson = vi.fn(async () => []) as never;
    const handle = startDesignReviewPushPoller(
      makeOpts({ enabled: false, sendFeishuMessage: send, ghJson }),
    );
    await handle.pollOnce();
    expect(send).not.toHaveBeenCalled();
    handle.stop();
  });

  it('throws when receiverOpenId is missing', () => {
    expect(() => startDesignReviewPushPoller(makeOpts({ receiverOpenId: '' }))).toThrow(
      /receiverOpenId/,
    );
  });

  it('throws when repo is malformed', () => {
    expect(() => startDesignReviewPushPoller(makeOpts({ repo: 'not-a-repo' }))).toThrow(
      /owner\/name/,
    );
  });

  it('pushes once per (PR, comment) and dedupes on subsequent ticks', async () => {
    const send = vi.fn<(params: { receiverOpenId: string; text: string }) => Promise<void>>(
      async () => {},
    );
    const ghJson = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return [
          {
            number: 38,
            title: 'docs: postline reframe RFC',
            url: 'https://github.com/Christianye/postline/pull/38',
            state: 'OPEN',
          },
        ];
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return { files: [{ path: 'docs/designs/postline-reframe.md' }] };
      }
      if (args[0] === 'api') {
        return [
          {
            id: 1001,
            user: { login: 'Christianye' },
            body: 'looks good\n\nlock RF1-RF8',
            created_at: '2026-06-07T08:00:00Z',
            html_url: 'https://github.com/Christianye/postline/pull/38#issuecomment-1001',
          },
        ];
      }
      return [];
    }) as never;

    const handle = startDesignReviewPushPoller(makeOpts({ sendFeishuMessage: send, ghJson }));
    await handle.pollOnce();
    await handle.pollOnce();
    handle.stop();

    expect(send).toHaveBeenCalledTimes(1);
    const sentArg = send.mock.calls[0]?.[0];
    expect(sentArg?.receiverOpenId).toBe('ou_test');
    expect(sentArg?.text).toContain('PR #38');
    expect(sentArg?.text).toContain('@Christianye');
    expect(sentArg?.text).toContain('looks good');

    // State file persisted
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      pushed: Record<string, string>;
    };
    expect(persisted.pushed['38:1001']).toBeTruthy();
  });

  it('skips PRs whose files do not match watchPaths', async () => {
    const send = vi.fn(async () => {});
    const ghJson = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return [{ number: 35, title: 'feat: deploy', url: 'x', state: 'OPEN' }];
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return { files: [{ path: 'deploy/docker/Dockerfile' }] };
      }
      return [];
    }) as never;
    const handle = startDesignReviewPushPoller(makeOpts({ sendFeishuMessage: send, ghJson }));
    await handle.pollOnce();
    handle.stop();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not mark a comment as pushed when send fails (so it retries next tick)', async () => {
    let sendCalls = 0;
    const send = vi.fn(async () => {
      sendCalls++;
      if (sendCalls === 1) throw new Error('feishu down');
    });
    const ghJson = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return [{ number: 38, title: 't', url: 'u', state: 'OPEN' }];
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return { files: [{ path: 'docs/designs/foo.md' }] };
      }
      if (args[0] === 'api') {
        return [
          {
            id: 99,
            user: { login: 'someone' },
            body: 'review body',
            created_at: '2026-06-07T08:00:00Z',
            html_url: 'u',
          },
        ];
      }
      return [];
    }) as never;
    const handle = startDesignReviewPushPoller(makeOpts({ sendFeishuMessage: send, ghJson }));
    await handle.pollOnce();
    await handle.pollOnce();
    handle.stop();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('skips comments without a known author', async () => {
    const send = vi.fn(async () => {});
    const ghJson = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return [{ number: 38, title: 't', url: 'u', state: 'OPEN' }];
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return { files: [{ path: 'docs/designs/bar.md' }] };
      }
      if (args[0] === 'api') {
        return [{ id: 1, user: null, body: 'ghost', created_at: 'x', html_url: 'y' }];
      }
      return [];
    }) as never;
    const handle = startDesignReviewPushPoller(makeOpts({ sendFeishuMessage: send, ghJson }));
    await handle.pollOnce();
    handle.stop();
    expect(send).not.toHaveBeenCalled();
  });

  it('survives a tick that throws inside ghJson', async () => {
    const send = vi.fn(async () => {});
    const ghJson = vi.fn(async () => {
      throw new Error('gh exploded');
    }) as never;
    const handle = startDesignReviewPushPoller(makeOpts({ sendFeishuMessage: send, ghJson }));
    await expect(handle.pollOnce()).resolves.toBeUndefined();
    handle.stop();
    expect(send).not.toHaveBeenCalled();
  });

  it('persists prior state and respects it across handles', async () => {
    writeFileSync(stateFile, JSON.stringify({ pushed: { '38:1001': '2026-06-07T07:00:00Z' } }));
    const send = vi.fn(async () => {});
    const ghJson = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return [{ number: 38, title: 't', url: 'u', state: 'OPEN' }];
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return { files: [{ path: 'docs/designs/baz.md' }] };
      }
      if (args[0] === 'api') {
        return [
          {
            id: 1001,
            user: { login: 'a' },
            body: 'old comment',
            created_at: 'x',
            html_url: 'y',
          },
        ];
      }
      return [];
    }) as never;
    const handle = startDesignReviewPushPoller(makeOpts({ sendFeishuMessage: send, ghJson }));
    await handle.pollOnce();
    handle.stop();
    expect(send).not.toHaveBeenCalled();
  });
});
