import { describe, expect, it } from 'vitest';
import { createBuiltinTools } from './registry.js';

describe('createBuiltinTools', () => {
  it('instantiates the requested ids and only those', () => {
    const tools = createBuiltinTools(['echo', 'bash_read'], {}, {});
    expect(tools.map((t) => t.name).sort()).toEqual(['bash_read', 'echo']);
  });

  it('expands multi-tool ids like fs into its 3 tools', () => {
    const tools = createBuiltinTools(['fs'], {}, {});
    expect(tools.map((t) => t.name).sort()).toEqual(['fs_edit', 'fs_read', 'fs_write']);
  });

  it('expands lark_docs into its 3 tools when feishu context present', () => {
    const tools = createBuiltinTools(
      ['lark_docs'],
      {},
      { feishu: { appId: 'cli_x', appSecret: 'x'.repeat(32) } },
    );
    expect(tools.map((t) => t.name).sort()).toEqual([
      'lark_doc_list',
      'lark_doc_read',
      'lark_doc_search',
    ]);
  });

  it('rejects lark_docs without feishu context', () => {
    expect(() => createBuiltinTools(['lark_docs'], {}, {})).toThrow(/requires ctx.feishu/);
  });

  it('rejects feishu_send without feishu context', () => {
    expect(() =>
      createBuiltinTools(['feishu_send'], { feishu_send: { sendAllowlist: ['oc_x'] } }, {}),
    ).toThrow(/requires ctx.feishu/);
  });

  it('rejects feishu_send without explicit sendAllowlist in options', () => {
    expect(() =>
      createBuiltinTools(
        ['feishu_send'],
        {},
        { feishu: { appId: 'cli_x', appSecret: 'x'.repeat(32) } },
      ),
    ).toThrow(/sendAllowlist/);
  });

  it('builds feishu_send when both feishu ctx + sendAllowlist provided', () => {
    const tools = createBuiltinTools(
      ['feishu_send'],
      { feishu_send: { sendAllowlist: ['oc_x'] } },
      { feishu: { appId: 'cli_x', appSecret: 'x'.repeat(32) } },
    );
    expect(tools.map((t) => t.name)).toEqual(['feishu_send']);
  });

  it('rejects memory without memoryDir', () => {
    expect(() => createBuiltinTools(['memory'], {}, {})).toThrow(/requires ctx.memoryDir/);
  });

  it('catches duplicate ids', () => {
    expect(() => createBuiltinTools(['echo', 'echo'], {}, {})).toThrow(/duplicate tool id/);
  });

  it('maintains requested order in output (for display stability)', () => {
    const tools = createBuiltinTools(['bash_read', 'echo', 'bash'], {}, {});
    expect(tools.map((t) => t.name)).toEqual(['bash_read', 'echo', 'bash']);
  });
});
