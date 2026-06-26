import { describe, it, expect } from 'vitest';
import type { Database } from '@open-tag/storage';
import { SharedContextStore } from '../store.js';
import { SharedContextWriter } from '../writer.js';
import { DerivedFromEvidenceVerifier } from '../verifier.js';

// Stub db that records the inserted row and returns an id. The write-back path
// uses an inline evidenceRef, so admit() never calls db.select (no artifact lookup).
function makeStubDb(captured: { row?: Record<string, unknown> }): Database {
  return {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        captured.row = row;
        return { returning: () => Promise.resolve([{ id: 'sc-1' }]) };
      },
    }),
  } as unknown as Database;
}

describe('SharedContextWriter.recordTurnResult', () => {
  it('admits a grounded truncation gist derived from the result', async () => {
    const captured: { row?: Record<string, unknown> } = {};
    const writer = new SharedContextWriter(new SharedContextStore(makeStubDb(captured)));
    const result = await writer.recordTurnResult({
      sessionId: 's1',
      authorAgentId: 'agent-1',
      authorAgentKind: 'claude_code',
      resultText: 'Fixed lambdify single-element tuples by adding a trailing comma in _recursive_to_string.',
    });
    expect(result.admitted).toBe(true);
    expect(captured.row?.verified).toBe(true);
    expect(captured.row?.authorAgentKind).toBe('claude_code');
    expect(String(captured.row?.gist)).toContain('Fixed lambdify');
    expect(captured.row?.evidenceRef).toMatchObject({ kind: 'inline' });
  });

  it('skips writing on an empty/whitespace result', async () => {
    const captured: { row?: Record<string, unknown> } = {};
    const writer = new SharedContextWriter(new SharedContextStore(makeStubDb(captured)));
    const result = await writer.recordTurnResult({ sessionId: 's1', resultText: '   \n  ' });
    expect(result).toEqual({ admitted: false, reason: 'empty result' });
    expect(captured.row).toBeUndefined();
  });

  it('truncates a long result to a compact gist', async () => {
    const captured: { row?: Record<string, unknown> } = {};
    const writer = new SharedContextWriter(new SharedContextStore(makeStubDb(captured)), {
      maxGistChars: 50,
    });
    const long = 'word '.repeat(200);
    const result = await writer.recordTurnResult({ sessionId: 's1', resultText: long });
    expect(result.admitted).toBe(true);
    expect(String(captured.row?.gist).length).toBeLessThanOrEqual(50);
  });

  it('preserves no-self-verify: a verifier whose id equals the author is rejected', async () => {
    const captured: { row?: Record<string, unknown> } = {};
    const writer = new SharedContextWriter(new SharedContextStore(makeStubDb(captured)), {
      verifier: new DerivedFromEvidenceVerifier('agent-1'), // same id as the author
    });
    const result = await writer.recordTurnResult({
      sessionId: 's1',
      authorAgentId: 'agent-1',
      resultText: 'some grounded result text',
    });
    expect(result.admitted).toBe(false);
    if (!result.admitted) expect(result.reason).toMatch(/no-self-verify/);
    expect(captured.row).toBeUndefined();
  });
});
