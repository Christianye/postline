import type { HistoryStore, Message } from '@postline/core';

/**
 * In-process history — fine for the CLI. EC2 deploy will swap in SQLite.
 */
export function createMemoryHistory(): HistoryStore {
  const store = new Map<string, Message[]>();
  return {
    async load(cid: string, limit: number) {
      const all = store.get(cid) ?? [];
      return all.slice(-limit);
    },
    async append(cid: string, msgs: Message[]) {
      const cur = store.get(cid) ?? [];
      store.set(cid, [...cur, ...msgs]);
    },
  };
}
