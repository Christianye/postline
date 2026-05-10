import pino from 'pino';
import type { Logger } from './types.js';

/**
 * Create a root logger. We default to metadata-only (no message bodies)
 * unless CC_LOG_LEVEL=full is set.
 */
export function createLogger(opts: { level?: string; name?: string } = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info';
  const logger = pino({
    level,
    name: opts.name ?? 'postline',
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Redact common secret patterns defensively.
    redact: {
      paths: [
        '*.appSecret',
        '*.app_secret',
        '*.token',
        '*.secret',
        '*.apiKey',
        '*.password',
        '*.authorization',
        'headers.authorization',
      ],
      remove: true,
    },
  });
  return logger as unknown as Logger;
}
