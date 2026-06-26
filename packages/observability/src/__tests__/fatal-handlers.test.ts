import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { installFatalProcessHandlers } from '../fatal-handlers.js';

function setup(options: { cleanup?: () => Promise<void> | void; cleanupTimeoutMs?: number } = {}) {
  const proc = new EventEmitter();
  const logger = { fatal: vi.fn(), error: vi.fn() };
  const exit = vi.fn();
  installFatalProcessHandlers({
    logger,
    cleanup: options.cleanup,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
    exit,
    proc: proc as unknown as NodeJS.Process,
  });
  return { proc, logger, exit };
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('installFatalProcessHandlers', () => {
  it('logs, runs cleanup, and exits 1 on unhandledRejection', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const { proc, logger, exit } = setup({ cleanup });

    proc.emit('unhandledRejection', new Error('floating promise'));
    await flushAsync();

    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unhandledRejection' }),
      expect.any(String),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs, runs cleanup, and exits 1 on uncaughtException', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const { proc, exit } = setup({ cleanup });

    proc.emit('uncaughtException', new Error('boom'));
    await flushAsync();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('only handles the first fatal error (one-shot)', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const { proc, logger, exit } = setup({ cleanup });

    proc.emit('uncaughtException', new Error('first'));
    proc.emit('unhandledRejection', new Error('second'));
    await flushAsync();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unhandledRejection' }),
      expect.any(String),
    );
  });

  it('still exits 1 when cleanup throws', async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error('cleanup broken'));
    const { proc, logger, exit } = setup({ cleanup });

    proc.emit('uncaughtException', new Error('boom'));
    await flushAsync();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.any(String),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits even when cleanup hangs past the timeout', async () => {
    vi.useFakeTimers();
    try {
      const cleanup = vi.fn(() => new Promise<void>(() => {}));
      const { proc, exit } = setup({ cleanup, cleanupTimeoutMs: 1000 });

      proc.emit('uncaughtException', new Error('boom'));
      await vi.advanceTimersByTimeAsync(1500);

      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits without cleanup when none is provided', async () => {
    const { proc, exit } = setup();

    proc.emit('unhandledRejection', 'string rejection reason');
    await flushAsync();

    expect(exit).toHaveBeenCalledWith(1);
  });
});
