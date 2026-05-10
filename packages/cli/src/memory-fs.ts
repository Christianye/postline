import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Memory } from '@postline/core';

/**
 * A minimal filesystem-backed Memory for local dev.
 * Reads MEMORY.md from a directory if present; otherwise returns an empty string.
 * This is sufficient for the CLI smoke test; EC2 deploy will use a git-synced impl.
 */
export function createFsMemory(dir: string): Memory {
  return {
    async load() {
      const path = join(dir, 'MEMORY.md');
      if (!existsSync(path)) return '';
      try {
        return await readFile(path, 'utf8');
      } catch {
        return '';
      }
    },
    async read(name: string) {
      const path = join(dir, name);
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    async write(name: string, content: string) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), content, 'utf8');
    },
  };
}
