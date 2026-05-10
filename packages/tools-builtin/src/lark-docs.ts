import * as Lark from '@larksuiteoapi/node-sdk';
import mammoth from 'mammoth';
import type { Tool, ToolContext, ToolResult } from '@postline/core';
import { parseLarkUrl, type LarkResource } from './lark-url.js';

export interface LarkDocsOptions {
  appId: string;
  appSecret: string;
  /** `Lark.Domain.Feishu` (cn, default) or `Lark.Domain.Lark` (global). */
  domain?: string;
  /** Max bytes returned by read tool. Default 256KB. */
  maxBytes?: number;
  /** Per-call timeout. Default 30s. */
  timeoutMs?: number;
}

export function createLarkDocsTools(opts: LarkDocsOptions): Tool[] {
  const client = new Lark.Client({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: opts.domain ?? Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
  });
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const read: Tool = {
    name: 'lark_doc_read',
    description:
      'Read a Feishu/Lark document by URL. Supports docx, wiki, sheets, bitable, slides (pdf export), drive file, and old doc. Returns plain text (or JSON for bitable). Truncated to 256KB.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL like https://xxx.feishu.cn/docx/xxx' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const url = typeof args.url === 'string' ? args.url : '';
      const parsed = parseLarkUrl(url);
      if (!parsed) return { content: `ERROR: cannot parse lark URL: ${url}`, isError: true };
      return withTimeout(() => readResource(client, parsed, ctx, maxBytes), timeoutMs);
    },
  };

  const list: Tool = {
    name: 'lark_doc_list',
    description:
      'List immediate children of a Feishu/Lark drive folder (given the folder URL). Not recursive. Returns name + type + token for each item.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    async run(args) {
      const url = typeof args.url === 'string' ? args.url : '';
      const parsed = parseLarkUrl(url);
      if (!parsed) return { content: `ERROR: cannot parse lark URL: ${url}`, isError: true };
      if (parsed.kind !== 'folder') {
        return {
          content: `ERROR: lark_doc_list only accepts folder URLs; got ${parsed.kind}`,
          isError: true,
        };
      }
      return withTimeout(() => listFolder(client, parsed.token), timeoutMs);
    },
  };

  const search: Tool = {
    name: 'lark_doc_search',
    description:
      'Search Feishu/Lark documents by keyword. Returns top 20 matches with url + title. Uses suite/docs-api/search/object under the hood.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        /** Optional filter: 'docx' | 'sheet' | 'bitable' | 'slides' | 'doc' | 'file' */
        type: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args) {
      const query = typeof args.query === 'string' ? args.query : '';
      const type = typeof args.type === 'string' ? args.type : undefined;
      if (!query) return { content: 'ERROR: query required', isError: true };
      return withTimeout(() => searchDocs(client, query, type), timeoutMs);
    },
  };

  return [read, list, search];
}

async function readResource(
  client: Lark.Client,
  res: LarkResource,
  _ctx: ToolContext,
  maxBytes: number,
): Promise<ToolResult> {
  try {
    switch (res.kind) {
      case 'docx':
        return readDocx(client, res.token, maxBytes);
      case 'wiki': {
        // Wiki URL uses a node token; resolve to an underlying obj_type + obj_token.
        const node = await getWikiNode(client, res.token);
        if (!node) return { content: 'ERROR: wiki node not found', isError: true };
        if (node.objType === 'docx') return readDocx(client, node.objToken, maxBytes);
        if (node.objType === 'doc') return readOldDoc(client, node.objToken, maxBytes);
        if (node.objType === 'sheet') return readSheet(client, node.objToken, maxBytes);
        if (node.objType === 'bitable') return readBitable(client, node.objToken, maxBytes);
        return {
          content: `ERROR: wiki node points to unsupported obj_type=${node.objType}`,
          isError: true,
        };
      }
      case 'sheet':
        return readSheet(client, res.token, maxBytes);
      case 'bitable':
        return readBitable(client, res.token, maxBytes);
      case 'slides':
        return readSlides(client, res.token, maxBytes);
      case 'file':
        return readDriveFile(client, res.token, maxBytes);
      case 'doc':
        return readOldDoc(client, res.token, maxBytes);
      case 'folder':
        return {
          content: 'ERROR: folder URLs are for lark_doc_list, not lark_doc_read',
          isError: true,
        };
    }
  } catch (e) {
    return { content: `ERROR: ${(e as Error).message}`, isError: true };
  }
}

async function readDocx(
  client: Lark.Client,
  documentId: string,
  maxBytes: number,
): Promise<ToolResult> {
  const resp = (await client.docx.v1.document.rawContent({
    path: { document_id: documentId },
  })) as { data?: { content?: string }; code?: number; msg?: string };
  if (resp.code && resp.code !== 0) {
    return { content: `ERROR: docx read failed (${resp.code}): ${resp.msg}`, isError: true };
  }
  const text = resp.data?.content ?? '';
  return truncate(text, maxBytes, { docType: 'docx', documentId });
}

async function readOldDoc(
  client: Lark.Client,
  docToken: string,
  _maxBytes: number,
): Promise<ToolResult> {
  // Old doc format — Node SDK has less coverage. Prefer advising migration.
  // Raw HTTP endpoint: /open-apis/doc/v2/:docToken/raw_content
  const resp = (await (client as unknown as {
    request: (args: {
      method: string;
      url: string;
    }) => Promise<{ data?: { content?: string }; code?: number; msg?: string }>;
  }).request({
    method: 'GET',
    url: `/open-apis/doc/v2/${docToken}/raw_content`,
  })) as { data?: { content?: string }; code?: number; msg?: string };
  if (resp.code && resp.code !== 0) {
    return {
      content: `ERROR: old doc read failed (${resp.code}): ${resp.msg}. Consider migrating to docx.`,
      isError: true,
    };
  }
  const text = resp.data?.content ?? '';
  return truncate(text, _maxBytes, { docType: 'doc', docToken });
}

async function readSheet(
  client: Lark.Client,
  spreadsheetToken: string,
  maxBytes: number,
): Promise<ToolResult> {
  // Step 1: list sheets in the spreadsheet.
  const sheetsResp = (await client.sheets.v3.spreadsheetSheet.query({
    path: { spreadsheet_token: spreadsheetToken },
  })) as {
    data?: { sheets?: Array<{ sheet_id: string; title: string; grid_properties?: { row_count?: number; column_count?: number } }> };
    code?: number;
    msg?: string;
  };
  if (sheetsResp.code && sheetsResp.code !== 0) {
    return { content: `ERROR: sheet list failed (${sheetsResp.code}): ${sheetsResp.msg}`, isError: true };
  }
  const sheets = sheetsResp.data?.sheets ?? [];
  if (sheets.length === 0) return { content: '(empty spreadsheet)' };

  // Step 2: for each sheet, read A1:last via legacy v2 /values/ endpoint (SDK doesn't expose v2 values).
  const parts: string[] = [];
  for (const sh of sheets) {
    const rowCount = Math.min(sh.grid_properties?.row_count ?? 100, 200);
    const colCount = Math.min(sh.grid_properties?.column_count ?? 26, 40);
    const lastCol = colIndexToLetter(colCount);
    const range = `${sh.sheet_id}!A1:${lastCol}${rowCount}`;
    try {
      const vals = await httpRequest<{
        data?: { valueRange?: { values?: unknown[][] } };
        code?: number;
        msg?: string;
      }>(client, {
        method: 'GET',
        url: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}`,
      });
      if (vals.code && vals.code !== 0) {
        parts.push(`## ${sh.title}\n(failed: ${vals.msg})`);
        continue;
      }
      const rows = vals.data?.valueRange?.values ?? [];
      parts.push(`## ${sh.title}\n${renderRows(rows)}`);
    } catch (e) {
      parts.push(`## ${sh.title}\n(error: ${(e as Error).message})`);
    }
  }
  return truncate(parts.join('\n\n'), maxBytes, { docType: 'sheet', spreadsheetToken });
}

async function readBitable(
  client: Lark.Client,
  appToken: string,
  maxBytes: number,
): Promise<ToolResult> {
  const tables = (await client.bitable.v1.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100 },
  })) as { data?: { items?: Array<{ table_id: string; name: string }> }; code?: number; msg?: string };
  if (tables.code && tables.code !== 0) {
    return { content: `ERROR: bitable list tables failed (${tables.code}): ${tables.msg}`, isError: true };
  }
  const list = tables.data?.items ?? [];
  if (list.length === 0) return { content: '(empty bitable)' };

  const parts: string[] = [];
  for (const t of list) {
    try {
      const recs = (await client.bitable.v1.appTableRecord.list({
        path: { app_token: appToken, table_id: t.table_id },
        params: { page_size: 50 },
      })) as {
        data?: { items?: Array<{ record_id: string; fields: Record<string, unknown> }> };
        code?: number;
        msg?: string;
      };
      const items = recs.data?.items ?? [];
      parts.push(
        `## ${t.name} (${items.length} records, showing up to 50)\n${JSON.stringify(items, null, 2)}`,
      );
    } catch (e) {
      parts.push(`## ${t.name}\n(error: ${(e as Error).message})`);
    }
  }
  return truncate(parts.join('\n\n'), maxBytes, { docType: 'bitable', appToken });
}

async function readSlides(
  _client: Lark.Client,
  slidesToken: string,
  _maxBytes: number,
): Promise<ToolResult> {
  // Feishu's export_task/create in @larksuiteoapi/node-sdk 1.62 only supports
  // type: doc|sheet|bitable|docx — not slides. To export slides to PDF you'd
  // have to use a different endpoint (or call the OpenAPI raw). Deferred to
  // a later milestone; Phase 1 surfaces a clear "not supported yet" error so
  // the model can offer the user an alternative (screenshot, docx, etc.).
  return {
    content: `slides not supported in this milestone (token=${slidesToken}). Ask the operator to export to PDF manually, or screenshot the deck and send the image.`,
    isError: true,
  };
}

async function readDriveFile(
  client: Lark.Client,
  fileToken: string,
  maxBytes: number,
): Promise<ToolResult> {
  // First grab the filename from meta so we can pick the right extractor.
  const title = await getDriveFileTitle(client, fileToken);

  const resp = (await client.drive.v1.file.download({
    path: { file_token: fileToken },
  })) as unknown as { getReadableStream: () => NodeJS.ReadableStream };
  const stream = resp.getReadableStream();
  const chunks: Buffer[] = [];
  let total = 0;
  // Uploaded docx can exceed maxBytes; allow up to 8× for the raw zip since text
  // after mammoth extraction is usually much smaller.
  const downloadCap = maxBytes * 8;
  for await (const c of stream as AsyncIterable<Buffer>) {
    total += c.byteLength;
    if (total > downloadCap) break;
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);

  const lowered = (title ?? '').toLowerCase();
  if (lowered.endsWith('.docx') || looksLikeDocxZip(buf)) {
    try {
      const { value, messages } = await mammoth.extractRawText({ buffer: buf });
      const warnings = (messages ?? []).filter((m) => m.type === 'warning').length;
      return truncate(value, maxBytes, {
        docType: 'drive-file',
        fileToken,
        title: title ?? null,
        extractor: 'mammoth',
        warnings,
        bytesRaw: buf.byteLength,
      });
    } catch (e) {
      return {
        content: `ERROR: docx extraction failed for ${title ?? fileToken}: ${(e as Error).message}`,
        isError: true,
      };
    }
  }

  // Non-docx path: keep the old heuristic (text-ish → utf-8, else describe).
  const sample = buf.subarray(0, Math.min(buf.byteLength, 1024)).toString('utf8');
  const printable =
    sample.replace(/[\x00-\x08\x0e-\x1f]/g, '').length / Math.max(1, sample.length);
  if (printable > 0.85) {
    return truncate(buf.toString('utf8'), maxBytes, {
      docType: 'drive-file',
      fileToken,
      title: title ?? null,
    });
  }
  return {
    content: `Binary file "${title ?? '<unknown>'}" (${buf.byteLength} bytes). Not text; no extractor for this type yet. file_token=${fileToken}`,
    meta: { docType: 'drive-file', fileToken, title: title ?? null, bytes: buf.byteLength, binary: true },
  };
}

async function getDriveFileTitle(
  client: Lark.Client,
  fileToken: string,
): Promise<string | null> {
  try {
    const resp = await httpRequest<{
      data?: { metas?: Array<{ title?: string; doc_token?: string }> };
      code?: number;
    }>(client, {
      method: 'POST',
      url: '/open-apis/drive/v1/metas/batch_query',
      data: {
        request_docs: [{ doc_token: fileToken, doc_type: 'file' }],
      },
    });
    if (resp.code && resp.code !== 0) return null;
    return resp.data?.metas?.[0]?.title ?? null;
  } catch {
    return null;
  }
}

function looksLikeDocxZip(buf: Buffer): boolean {
  // All zip files start with `PK\x03\x04`. This is necessary but not sufficient
  // to conclude docx; used only as a fallback when we don't have a title.
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  );
}

async function getWikiNode(
  client: Lark.Client,
  token: string,
): Promise<{ objType: string; objToken: string } | null> {
  const resp = (await client.wiki.v2.space.getNode({
    params: { token, obj_type: 'wiki' as 'wiki' },
  })) as { data?: { node?: { obj_type?: string; obj_token?: string } }; code?: number; msg?: string };
  if (resp.code && resp.code !== 0) {
    throw new Error(`wiki.getNode failed (${resp.code}): ${resp.msg}`);
  }
  const n = resp.data?.node;
  if (!n?.obj_type || !n.obj_token) return null;
  return { objType: n.obj_type, objToken: n.obj_token };
}

async function listFolder(client: Lark.Client, folderToken: string): Promise<ToolResult> {
  const resp = (await client.drive.v1.file.list({
    params: { folder_token: folderToken, page_size: 200 },
  })) as {
    data?: { files?: Array<{ token: string; name: string; type: string; owner_id?: string }> };
    code?: number;
    msg?: string;
  };
  if (resp.code && resp.code !== 0) {
    return { content: `ERROR: folder list failed (${resp.code}): ${resp.msg}`, isError: true };
  }
  const files = resp.data?.files ?? [];
  if (files.length === 0) return { content: `folder ${folderToken} is empty` };
  const lines = files.map((f) => `- ${f.name}  [${f.type}]  token=${f.token}`);
  return {
    content: `folder_token: ${folderToken}\nitems (${files.length}):\n${lines.join('\n')}`,
    meta: { count: files.length },
  };
}

async function searchDocs(
  client: Lark.Client,
  query: string,
  type?: string,
): Promise<ToolResult> {
  // /suite/docs-api/search/object is a POST with {search_key, count, offset, [doc_type]}
  const body: Record<string, unknown> = { search_key: query, count: 20, offset: 0 };
  if (type) body.doc_type = type;
  const resp = await httpRequest<{
    data?: { docs_entities?: Array<{ docs_token: string; docs_type: string; title: string; url?: string }> };
    code?: number;
    msg?: string;
  }>(client, {
    method: 'POST',
    url: '/open-apis/suite/docs-api/search/object',
    data: body,
  });
  if (resp.code && resp.code !== 0) {
    return { content: `ERROR: docs search failed (${resp.code}): ${resp.msg}`, isError: true };
  }
  const hits = resp.data?.docs_entities ?? [];
  if (hits.length === 0) return { content: `no results for "${query}"` };
  const lines = hits.map(
    (h) => `- [${h.docs_type}] ${h.title}  token=${h.docs_token}${h.url ? `  url=${h.url}` : ''}`,
  );
  return {
    content: `search "${query}" — ${hits.length} hits:\n${lines.join('\n')}`,
    meta: { count: hits.length },
  };
}

async function httpRequest<T>(
  client: Lark.Client,
  args: { method: string; url: string; data?: unknown; params?: unknown },
): Promise<T> {
  return (await (client as unknown as {
    request: (a: typeof args) => Promise<T>;
  }).request(args)) as T;
}

function truncate(
  text: string,
  maxBytes: number,
  meta: Record<string, unknown>,
): ToolResult {
  const enc = Buffer.byteLength(text, 'utf8');
  if (enc <= maxBytes) {
    return { content: text, meta: { ...meta, bytes: enc, truncated: false } };
  }
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  return {
    content: `${buf.toString('utf8')}\n[...truncated ${enc - maxBytes} bytes]`,
    meta: { ...meta, bytes: enc, truncated: true },
  };
}

async function withTimeout(fn: () => Promise<ToolResult>, timeoutMs: number): Promise<ToolResult> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ content: `ERROR: lark_doc call timed out after ${timeoutMs}ms`, isError: true }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function colIndexToLetter(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || 'A';
}

function renderRows(rows: unknown[][]): string {
  if (rows.length === 0) return '(empty)';
  return rows
    .map((r) => r.map((c) => (c == null ? '' : String(c))).join('\t'))
    .join('\n');
}
