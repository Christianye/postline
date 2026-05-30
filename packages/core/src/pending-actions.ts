/**
 * A tiny action-approval registry. Shared by chat and IM adapters:
 *   1. Tool handler encounters a dangerous call → calls `ask()` to stash a promise.
 *   2. Adapter surfaces the pending action to the user (text / card / whatever).
 *   3. User replies `/approve <id>` or `/deny <id>` → adapter calls `resolve()`.
 *   4. Pending map entries expire after `ttlMs`.
 *
 * Not exported to tool-authors directly — it's wired by the adapter layer.
 */

export interface PendingAction {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  userId: string;
  conversationId: string;
  expiresAt: number;
  resolve: (approved: boolean) => void;
}

export interface PendingActions {
  create(init: Omit<PendingAction, 'expiresAt' | 'resolve'> & { ttlMs?: number }): Promise<boolean>;
  approve(id: string): boolean;
  deny(id: string): boolean;
  list(conversationId?: string): PendingAction[];
  /**
   * Look up an entry without resolving it. Returns undefined if the id has
   * already been approved/denied/expired. Used by adapters that need the
   * tool name etc. when rendering a "resolved" UI on click.
   */
  get(id: string): PendingAction | undefined;
  cleanup(): void;
}

export function createPendingActions(defaultTtlMs = 5 * 60_000): PendingActions {
  const pending = new Map<string, PendingAction>();
  const api: PendingActions = {
    create({ ttlMs, ...init }) {
      api.cleanup();
      return new Promise<boolean>((resolve) => {
        const ttl = ttlMs ?? defaultTtlMs;
        const entry: PendingAction = {
          ...init,
          expiresAt: Date.now() + ttl,
          resolve: (ok) => {
            pending.delete(init.id);
            resolve(ok);
          },
        };
        pending.set(init.id, entry);
        setTimeout(() => {
          if (pending.has(init.id)) entry.resolve(false);
        }, ttl).unref();
      });
    },
    approve(id) {
      const p = pending.get(id);
      if (!p) return false;
      p.resolve(true);
      return true;
    },
    deny(id) {
      const p = pending.get(id);
      if (!p) return false;
      p.resolve(false);
      return true;
    },
    list(conversationId) {
      api.cleanup();
      const items: PendingAction[] = [];
      for (const p of pending.values()) {
        if (!conversationId || p.conversationId === conversationId) items.push(p);
      }
      return items;
    },
    get(id) {
      const p = pending.get(id);
      if (!p) return undefined;
      if (p.expiresAt <= Date.now()) {
        // Lazily expire on read so callers never see a stale entry.
        p.resolve(false);
        pending.delete(id);
        return undefined;
      }
      return p;
    },
    cleanup() {
      const now = Date.now();
      for (const [id, p] of pending) {
        if (p.expiresAt <= now) {
          p.resolve(false);
          pending.delete(id);
        }
      }
    },
  };
  return api;
}
