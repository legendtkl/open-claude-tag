import type { Logger } from 'pino';
import type { Database } from '@open-tag/storage';
import {
  SharedContextStore,
  SharedContextWriter,
  type RecordTurnInput,
  type RecordTurnResult,
} from '@open-tag/memory';

interface TurnWriter {
  recordTurnResult(input: RecordTurnInput): Promise<RecordTurnResult>;
}

export interface RecordTurnGistDeps {
  db: Database;
  logger: Pick<Logger, 'info' | 'warn'>;
  enabled: boolean;
  /** Override for tests; defaults to a real SharedContextWriter over the db. */
  writerFactory?: (db: Database) => TurnWriter;
}

/**
 * Best-effort write of a completed turn's verified gist into the shared context.
 * Fire-and-forget by design: the task is already terminal, so this MUST NOT
 * block the user-visible completion path and MUST NOT throw into it — even a
 * synchronous failure in constructing/calling the writer is swallowed.
 */
export function recordTurnGistBestEffort(deps: RecordTurnGistDeps, input: RecordTurnInput): void {
  if (!deps.enabled) return;
  if (!input.resultText || input.resultText.trim().length === 0) return;

  void Promise.resolve()
    .then(() => {
      const writer = deps.writerFactory
        ? deps.writerFactory(deps.db)
        : new SharedContextWriter(new SharedContextStore(deps.db));
      return writer.recordTurnResult(input);
    })
    .then((recorded) => {
      if (!recorded.admitted) {
        deps.logger.info(
          { sessionId: input.sessionId, reason: recorded.reason },
          'Shared-context gist not admitted',
        );
      }
    })
    .catch((err) => {
      deps.logger.warn(
        { sessionId: input.sessionId, err },
        'Failed to write verified shared-context gist (best-effort)',
      );
    });
}
