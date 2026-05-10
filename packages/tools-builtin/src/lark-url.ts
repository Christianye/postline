/**
 * Parse a Feishu/Lark URL into {kind, token}.
 * Supports: docx, doc, sheets, base (bitable), slides, file, drive/folder, wiki.
 */

export type LarkResourceKind =
  | 'docx'
  | 'doc'
  | 'sheet'
  | 'bitable'
  | 'slides'
  | 'file'
  | 'folder'
  | 'wiki';

export interface LarkResource {
  kind: LarkResourceKind;
  token: string;
}

const PATTERNS: Array<{ re: RegExp; kind: LarkResourceKind }> = [
  { re: /\/docx\/([A-Za-z0-9]+)/u, kind: 'docx' },
  { re: /\/doc\/([A-Za-z0-9]+)/u, kind: 'doc' },
  { re: /\/sheets\/([A-Za-z0-9]+)/u, kind: 'sheet' },
  { re: /\/base\/([A-Za-z0-9]+)/u, kind: 'bitable' },
  { re: /\/slides\/([A-Za-z0-9]+)/u, kind: 'slides' },
  { re: /\/file\/([A-Za-z0-9]+)/u, kind: 'file' },
  { re: /\/drive\/folder\/([A-Za-z0-9]+)/u, kind: 'folder' },
  { re: /\/wiki\/([A-Za-z0-9]+)/u, kind: 'wiki' },
];

export function parseLarkUrl(url: string): LarkResource | null {
  if (!url || typeof url !== 'string') return null;
  // Accept bare tokens? We don't — too ambiguous.
  try {
    new URL(url);
  } catch {
    return null;
  }
  for (const { re, kind } of PATTERNS) {
    const m = re.exec(url);
    if (m?.[1]) return { kind, token: m[1] };
  }
  return null;
}
