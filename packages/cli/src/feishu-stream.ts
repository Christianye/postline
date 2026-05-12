import type { FeishuChannel } from '@postline/adapters-feishu';
import type { Logger } from '@postline/core';

/**
 * Live-typing controller. Given a feishu channel + conversation id, returns
 * handles to feed text-delta chunks into and a finaliser that flushes the
 * final reply.
 *
 * Shape:
 *   1. First delta → send a seed message ("…"), capture its message_id.
 *   2. Subsequent deltas → debounce to the host-wide minimum edit interval,
 *      edit the seed message with the accumulated text.
 *   3. finish(finalReply) → flush any pending debounce, do one last edit with
 *      the final text. If the final reply exceeds MAX_EDIT_BYTES, the edit is
 *      replaced by the truncated portion + a "…continued" marker; overflow
 *      chunks are sent as follow-up messages by the caller's normal `send()`
 *      path (caller decides — we just return a `overflow` string if any).
 *   4. Any edit failure falls open: we stop editing, log, and let the caller
 *      send the full reply as a plain message.
 */
export interface StreamingHandle {
  onDelta: (accumulated: string) => void;
  /**
   * Flush final text. Returns either `'edited'` (final state was edited into
   * the seed message), `'overflow:<rest>'` (first slice edited, remainder for
   * caller to send), or `'failed'` (caller should send the full text as a
   * fresh message because editing failed or never started).
   */
  finish: (finalText: string) => Promise<FinishResult>;
}

export type FinishResult =
  | { kind: 'edited' }
  | { kind: 'overflow'; rest: string }
  | { kind: 'failed' };

export interface StreamingOptions {
  /** Minimum ms between edits. Default 250ms — safely below feishu rate limits. */
  debounceMs?: number;
  /** Max chars to edit into a single feishu message. Default 4500. */
  maxCharsPerMessage?: number;
  /** Seed message text before any content arrives. Default "…". */
  seedText?: string;
}

export function createStreamingMessage(
  channel: FeishuChannel,
  conversationId: string,
  log: Logger,
  opts: StreamingOptions = {},
): StreamingHandle {
  const debounceMs = opts.debounceMs ?? 250;
  const maxChars = opts.maxCharsPerMessage ?? 4500;
  const seedText = opts.seedText ?? '…';

  let seedMessageId: string | undefined;
  let seedPromise: Promise<void> | undefined;
  let lastPushed = '';
  let latest = '';
  let failed = false;
  let timer: NodeJS.Timeout | undefined;
  let editInFlight: Promise<void> = Promise.resolve();

  async function ensureSeed(): Promise<void> {
    if (seedMessageId || failed) return;
    if (!seedPromise) {
      seedPromise = (async () => {
        try {
          const { messageId } = await channel.sendText({
            conversationId,
            text: seedText,
          });
          seedMessageId = messageId;
        } catch (e) {
          failed = true;
          log.warn({ err: (e as Error).message }, 'feishu_stream_seed_failed');
        }
      })();
    }
    await seedPromise;
  }

  async function pushEdit(): Promise<void> {
    if (failed || !seedMessageId) return;
    const target = latest.slice(0, maxChars);
    if (target === lastPushed) return;
    try {
      await channel.editText(seedMessageId, target.length > 0 ? target : seedText);
      lastPushed = target;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      failed = true;
      log.warn({ err: msg }, 'feishu_stream_edit_failed');
    }
  }

  function scheduleEdit(): void {
    if (failed) return;
    if (timer) return; // already scheduled
    timer = setTimeout(() => {
      timer = undefined;
      editInFlight = editInFlight.then(() => pushEdit());
    }, debounceMs);
    timer.unref();
  }

  return {
    onDelta(accumulated) {
      if (failed) return;
      latest = accumulated;
      void ensureSeed();
      scheduleEdit();
    },

    async finish(finalText) {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await editInFlight;

      if (failed) return { kind: 'failed' };
      await ensureSeed();
      if (failed || !seedMessageId) return { kind: 'failed' };

      latest = finalText;
      if (finalText.length <= maxChars) {
        await pushEdit();
        return failed ? { kind: 'failed' } : { kind: 'edited' };
      }
      // Overflow: edit the first slice into the seed message, return the rest
      // for the caller to send as follow-up messages.
      latest = finalText.slice(0, maxChars);
      await pushEdit();
      const rest = finalText.slice(maxChars);
      return failed ? { kind: 'failed' } : { kind: 'overflow', rest };
    },
  };
}
