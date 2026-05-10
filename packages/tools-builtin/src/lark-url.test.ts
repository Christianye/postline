import { describe, expect, it } from 'vitest';
import { parseLarkUrl } from './lark-url.js';

describe('parseLarkUrl', () => {
  const samples: Array<[string, { kind: string; token: string } | null]> = [
    ['https://feishu.cn/docx/abcDEF123', { kind: 'docx', token: 'abcDEF123' }],
    [
      'https://bytedance.feishu.cn/docx/doxcnby5Y0yoACL3PdfZqrJEm6f',
      { kind: 'docx', token: 'doxcnby5Y0yoACL3PdfZqrJEm6f' },
    ],
    ['https://feishu.cn/doc/oldTok1', { kind: 'doc', token: 'oldTok1' }],
    ['https://feishu.cn/sheets/shtTok1?sheet=1', { kind: 'sheet', token: 'shtTok1' }],
    ['https://feishu.cn/base/bazTok1', { kind: 'bitable', token: 'bazTok1' }],
    ['https://feishu.cn/slides/slsTok1', { kind: 'slides', token: 'slsTok1' }],
    ['https://feishu.cn/file/fileTok1', { kind: 'file', token: 'fileTok1' }],
    ['https://feishu.cn/drive/folder/folTok1', { kind: 'folder', token: 'folTok1' }],
    [
      'https://bytedance.feishu.cn/wiki/Xl2IfJrl2l9AsKdh6PJcseaVndb',
      { kind: 'wiki', token: 'Xl2IfJrl2l9AsKdh6PJcseaVndb' },
    ],
    ['not a url', null],
    ['https://example.com/', null],
    ['https://feishu.cn/random/path', null],
  ];

  for (const [url, expected] of samples) {
    it(`parses: ${url}`, () => {
      const got = parseLarkUrl(url);
      if (expected === null) expect(got).toBeNull();
      else {
        expect(got).not.toBeNull();
        expect(got?.kind).toBe(expected.kind);
        expect(got?.token).toBe(expected.token);
      }
    });
  }
});
