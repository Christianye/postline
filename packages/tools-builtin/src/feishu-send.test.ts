import type { ToolContext } from '@postline/core';
import { describe, expect, it, vi } from 'vitest';

// Capture the last `create` call payload across all tests so assertions can
// inspect what the tool actually asked the SDK to send.
const calls: Array<{ params: Record<string, unknown>; data: Record<string, unknown> }> = [];
let mockImpl: (arg: unknown) => Promise<unknown> = async () => ({
  data: { message_id: 'om_test' },
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class Client {
    im = {
      v1: {
        message: {
          create: (arg: { params: Record<string, unknown>; data: Record<string, unknown> }) => {
            calls.push(arg);
            return mockImpl(arg);
          },
        },
      },
    };
  }
  return {
    Client,
    Domain: { Feishu: 'feishu.cn', Lark: 'larksuite.com' },
    LoggerLevel: { warn: 2 },
  };
});

// Import AFTER vi.mock so the stub is installed.
import { createFeishuSendTool } from './feishu-send.js';

function fakeCtx(): ToolContext {
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => log,
  } as unknown as ToolContext['log'];
  return {
    userId: 'ou_test',
    conversationId: 'oc_test',
    log,
    signal: new AbortController().signal,
  };
}

describe('feishu_send', () => {
  it('rejects targets not on sendAllowlist', async () => {
    const tool = createFeishuSendTool({
      appId: 'x',
      appSecret: 'y',
      sendAllowlist: ['oc_allowed'],
    });
    const result = await tool.run({ chat_id: 'oc_unknown', text: 'hi' }, fakeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not on feishu\.sendAllowlist/);
  });

  it('accepts allowlisted chat_id and sends via SDK', async () => {
    calls.length = 0;
    const tool = createFeishuSendTool({
      appId: 'x',
      appSecret: 'y',
      sendAllowlist: ['oc_ok'],
    });
    const result = await tool.run({ chat_id: 'oc_ok', text: 'hello' }, fakeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/sent to oc_ok/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.receive_id_type).toBe('chat_id');
    expect(calls[0]?.data.receive_id).toBe('oc_ok');
    expect(calls[0]?.data.msg_type).toBe('text');
  });

  it('routes open_id (ou_) targets as DMs', async () => {
    calls.length = 0;
    const tool = createFeishuSendTool({
      appId: 'x',
      appSecret: 'y',
      sendAllowlist: ['ou_user'],
    });
    await tool.run({ chat_id: 'ou_user', text: 'hi' }, fakeCtx());
    expect(calls[0]?.params.receive_id_type).toBe('open_id');
  });

  it('prepends @-mentions when provided', async () => {
    calls.length = 0;
    const tool = createFeishuSendTool({
      appId: 'x',
      appSecret: 'y',
      sendAllowlist: ['oc_ok'],
    });
    await tool.run(
      { chat_id: 'oc_ok', text: 'report ready', mentions: ['ou_a', 'ou_b'] },
      fakeCtx(),
    );
    const raw = calls[0]?.data.content as string;
    const parsed = JSON.parse(raw) as { text: string };
    expect(parsed.text).toContain('<at user_id="ou_a"></at>');
    expect(parsed.text).toContain('<at user_id="ou_b"></at>');
    expect(parsed.text).toContain('report ready');
  });

  it('rejects messages over maxChars', async () => {
    const tool = createFeishuSendTool({
      appId: 'x',
      appSecret: 'y',
      sendAllowlist: ['oc_ok'],
      maxChars: 10,
    });
    const result = await tool.run({ chat_id: 'oc_ok', text: '12345678901234567890' }, fakeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/max 10/);
  });

  it('enforces per-target rate limit', async () => {
    calls.length = 0;
    const tool = createFeishuSendTool({
      appId: 'x',
      appSecret: 'y',
      sendAllowlist: ['oc_rl'],
      ratePerMin: 2,
    });
    await tool.run({ chat_id: 'oc_rl', text: 'a' }, fakeCtx());
    await tool.run({ chat_id: 'oc_rl', text: 'b' }, fakeCtx());
    const third = await tool.run({ chat_id: 'oc_rl', text: 'c' }, fakeCtx());
    expect(third.isError).toBe(true);
    expect(third.content).toMatch(/rate limit/);
    expect(calls).toHaveLength(2);
  });

  it('surfaces SDK errors as isError results (not thrown)', async () => {
    mockImpl = async () => {
      throw new Error('403 forbidden');
    };
    const tool = createFeishuSendTool({
      appId: 'x',
      appSecret: 'y',
      sendAllowlist: ['oc_err'],
    });
    const result = await tool.run({ chat_id: 'oc_err', text: 'hi' }, fakeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/403 forbidden/);
    // restore for other tests
    mockImpl = async () => ({ data: { message_id: 'om_test' } });
  });
});
