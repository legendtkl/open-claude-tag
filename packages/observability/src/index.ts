import pino from 'pino';
import type { Logger, LoggerOptions as PinoLoggerOptions } from 'pino';
import { resolve } from 'path';

export type { Logger } from 'pino';
export {
  installFatalProcessHandlers,
  type FatalProcessHandlerOptions,
} from './fatal-handlers.js';

export interface LoggerOptions {
  /** Override log level (default: LOG_LEVEL env or 'info') */
  level?: string;
  /** Override log directory for file transport (default: LOG_DIR env or '<cwd>/logs') */
  logDir?: string;
}

const LOG_FILE_ENABLED = process.env.LOG_FILE_ENABLED === 'true';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const LOG_DIR = process.env.LOG_DIR ?? resolve(process.cwd(), 'logs');
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS ?? '7', 10);

/**
 * Create a named Pino logger with stdout output and optional daily-rotating file transport.
 *
 * File transport is enabled when `LOG_FILE_ENABLED=true`.
 * Files are written to `LOG_DIR/<name>-YYYY-MM-DD.log` and rotated daily.
 * Old files are cleaned up after `LOG_RETENTION_DAYS` days (default 7).
 */
export function createLogger(name: string, opts?: LoggerOptions): Logger {
  const level = opts?.level ?? LOG_LEVEL;
  const logDir = opts?.logDir ?? LOG_DIR;

  if (!LOG_FILE_ENABLED) {
    return pino({ name, level });
  }

  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino/file',
      options: { destination: 1 }, // stdout
      level,
    },
    {
      target: 'pino-roll',
      options: {
        file: resolve(logDir, name),
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',
        extension: '.log',
        mkdir: true,
        limit: { count: LOG_RETENTION_DAYS },
      } satisfies Record<string, unknown>,
      level,
    },
  ];

  const transport = pino.transport({ targets });

  return pino({ name, level } as PinoLoggerOptions, transport);
}
