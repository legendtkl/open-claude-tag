import { describe, it, expect, vi } from 'vitest';
import type { Database } from '@open-tag/storage';
import { recordTurnGistBestEffort } from '../shared-context-writeback.js';

const db = {} as Database;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

const input = {
  sessionId: 's1',
  authorAgentId: 'agent-1',
  authorAgentKind: 'claude_code',
  resultText: 'a grounded result',
};

describe('recordTurnGistBestEffort', () => {
  it('does nothing when the feature flag is disabled', async () => {
    const writerFactory = vi.fn();
    recordTurnGistBestEffort({ db, logger: makeLogger(), enabled: false, writerFactory }, input);
    await flush();
    expect(writerFactory).not.toHaveBeenCalled();
  });

  it('skips an empty/whitespace result', async () => {
    const writerFactory = vi.fn();
    recordTurnGistBestEffort(
      { db, logger: makeLogger(), enabled: true, writerFactory },
      { ...input, resultText: '   ' },
    );
    await flush();
    expect(writerFactory).not.toHaveBeenCalled();
  });

  it('records the gist when enabled', async () => {
    const recordTurnResult = vi.fn().mockResolvedValue({ admitted: true, id: 'sc-1' });
    const logger = makeLogger();
    recordTurnGistBestEffort(
      { db, logger, enabled: true, writerFactory: () => ({ recordTurnResult }) },
      input,
    );
    await flush();
    expect(recordTurnResult).toHaveBeenCalledWith(input);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('never throws and swallows a writer failure (best-effort)', async () => {
    const logger = makeLogger();
    const writerFactory = () => ({
      recordTurnResult: vi.fn().mockRejectedValue(new Error('db down')),
    });
    // Must return synchronously without throwing even though the writer rejects.
    expect(() =>
      recordTurnGistBestEffort({ db, logger, enabled: true, writerFactory }, input),
    ).not.toThrow();
    await flush();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('logs when a gist is not admitted', async () => {
    const logger = makeLogger();
    const writerFactory = () => ({
      recordTurnResult: vi.fn().mockResolvedValue({ admitted: false, reason: 'empty result' }),
    });
    recordTurnGistBestEffort({ db, logger, enabled: true, writerFactory }, input);
    await flush();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'empty result' }),
      expect.any(String),
    );
  });
});
