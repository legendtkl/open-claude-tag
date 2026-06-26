import type { Logger } from 'pino';

export interface FatalProcessHandlerOptions {
  logger: Pick<Logger, 'fatal' | 'error'>;
  /** Best-effort cleanup before exiting (cancel runtimes, drain queues, ...). */
  cleanup?: () => Promise<void> | void;
  /** Upper bound on cleanup time before the process exits anyway. Default 10s. */
  cleanupTimeoutMs?: number;
  /** Injected for tests. Defaults to process.exit. */
  exit?: (code: number) => void;
  /** Injected for tests. Defaults to the global process. */
  proc?: Pick<NodeJS.Process, 'on'>;
}

/**
 * Register process-level `unhandledRejection` / `uncaughtException` handlers.
 *
 * Node ≥15 terminates on the first unhandled rejection with no cleanup, which
 * for long-running services means orphaned child processes and half-finished
 * work. These handlers log the fatal error, run a bounded best-effort cleanup
 * exactly once, and exit with code 1 so supervisors restart the service.
 */
export function installFatalProcessHandlers(options: FatalProcessHandlerOptions): void {
  const { logger, cleanup, cleanupTimeoutMs = 10_000 } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const proc = options.proc ?? process;
  let handling = false;

  const runCleanupAndExit = async (): Promise<void> => {
    try {
      if (cleanup) {
        await Promise.race([
          Promise.resolve().then(cleanup),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, cleanupTimeoutMs);
            timer.unref?.();
          }),
        ]);
      }
    } catch (err) {
      logger.error({ err }, 'Cleanup failed during fatal shutdown');
    } finally {
      exit(1);
    }
  };

  const handleFatal = (kind: 'unhandledRejection' | 'uncaughtException', err: unknown): void => {
    if (handling) {
      logger.error({ err, kind }, 'Additional fatal error while already shutting down');
      return;
    }
    handling = true;
    logger.fatal({ err, kind }, 'Fatal process error, shutting down');
    void runCleanupAndExit();
  };

  proc.on('unhandledRejection', (reason: unknown) => handleFatal('unhandledRejection', reason));
  proc.on('uncaughtException', (err: unknown) => handleFatal('uncaughtException', err));
}
