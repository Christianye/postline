import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@postline/core';

export interface FsToolsOptions {
  /**
   * Paths CC can freely read. Resolved to absolute, realpath not followed —
   * symlinks get compared by textual prefix. Defaults: just /tmp.
   */
  readAllow?: readonly string[];
  /**
   * Subset of readAllow that is also writable.
   */
  writeAllow?: readonly string[];
  /** Max bytes returned in a single read. Default 256KB. */
  maxReadBytes?: number;
}

function normalizeAllow(paths: readonly string[]): string[] {
  return paths.map((p) => resolve(p).replace(/\/+$/, ''));
}

function isWithin(target: string, allow: readonly string[]): boolean {
  const abs = resolve(target);
  for (const root of allow) {
    const rel = relative(root, abs);
    if (!rel.startsWith('..') && !rel.startsWith(`.${sep}..`)) return true;
  }
  return false;
}

export function createFsTools(opts: FsToolsOptions = {}): Tool[] {
  const readAllow = normalizeAllow(opts.readAllow ?? ['/tmp']);
  const writeAllow = normalizeAllow(opts.writeAllow ?? []);
  const maxReadBytes = opts.maxReadBytes ?? 256 * 1024;

  const readTool: Tool = {
    name: 'fs_read',
    description: `Read a text file. Allowed read roots: ${readAllow.join(', ')}. Returns file contents truncated to ${maxReadBytes} bytes.`,
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to read' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path) return { content: 'ERROR: path required', isError: true };
      if (!isWithin(path, readAllow)) {
        return {
          content: `ERROR: ${path} is outside readAllow roots (${readAllow.join(', ')})`,
          isError: true,
        };
      }
      try {
        const s = await stat(path);
        if (!s.isFile()) return { content: `ERROR: ${path} is not a file`, isError: true };
        const buf = await readFile(path);
        const truncated = buf.byteLength > maxReadBytes;
        const text = buf.subarray(0, maxReadBytes).toString('utf8');
        return {
          content: truncated ? `${text}\n[...${buf.byteLength - maxReadBytes} bytes truncated]` : text,
          meta: { bytes: buf.byteLength, truncated },
        };
      } catch (e) {
        return { content: `ERROR: ${(e as Error).message}`, isError: true };
      }
    },
  };

  const writeTool: Tool = {
    name: 'fs_write',
    description: `Write (overwrite) a text file. Parent dirs auto-created. Allowed write roots: ${writeAllow.join(', ') || '(none)'}.`,
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const path = typeof args.path === 'string' ? args.path : '';
      const content = typeof args.content === 'string' ? args.content : '';
      if (!path) return { content: 'ERROR: path required', isError: true };
      if (!isWithin(path, writeAllow)) {
        return {
          content: `ERROR: ${path} is outside writeAllow roots (${writeAllow.join(', ') || 'none'})`,
          isError: true,
        };
      }
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, 'utf8');
        return { content: `wrote ${content.length} chars to ${path}`, meta: { bytes: content.length } };
      } catch (e) {
        return { content: `ERROR: ${(e as Error).message}`, isError: true };
      }
    },
  };

  const editTool: Tool = {
    name: 'fs_edit',
    description:
      'Replace the first occurrence of `old_string` with `new_string` in a file. Fails if old_string is not unique. Use for targeted edits.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const path = typeof args.path === 'string' ? args.path : '';
      const oldStr = typeof args.old_string === 'string' ? args.old_string : '';
      const newStr = typeof args.new_string === 'string' ? args.new_string : '';
      if (!isWithin(path, writeAllow)) {
        return {
          content: `ERROR: ${path} is outside writeAllow roots`,
          isError: true,
        };
      }
      try {
        const buf = await readFile(path, 'utf8');
        const idx = buf.indexOf(oldStr);
        if (idx < 0) return { content: 'ERROR: old_string not found', isError: true };
        if (buf.indexOf(oldStr, idx + 1) >= 0) {
          return { content: 'ERROR: old_string is not unique in file', isError: true };
        }
        const next = buf.slice(0, idx) + newStr + buf.slice(idx + oldStr.length);
        await writeFile(path, next, 'utf8');
        return { content: `edit ok (${path}: -${oldStr.length}+${newStr.length} chars)` };
      } catch (e) {
        return { content: `ERROR: ${(e as Error).message}`, isError: true };
      }
    },
  };

  return [readTool, writeTool, editTool];
}
