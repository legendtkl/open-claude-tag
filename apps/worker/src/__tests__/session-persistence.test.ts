import { describe, it, expect, vi } from 'vitest';
import { persistSessionState } from '../session-persistence.js';
import { sessions } from '@open-tag/storage';

// ── Mock DB ──
function createMockDb() {
  const mockWhere = vi.fn().mockResolvedValue([]);
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
  return {
    update: mockUpdate,
    _getSetValues: () => mockSet.mock.calls[0]?.[0] as Record<string, unknown>,
    _getWhereArg: () => mockWhere.mock.calls[0]?.[0],
  };
}

describe('persistSessionState', () => {
  it('always updates runtimeBackend even when sdkSessionId is null (codex case)', async () => {
    const db = createMockDb();
    await persistSessionState(db as any, 'session_1', 'codex', null, null);

    expect(db.update).toHaveBeenCalledWith(sessions);
    const set = db._getSetValues();
    expect(set.runtimeBackend).toBe('codex');
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it('does NOT include sdkSessionId in the update when it is null', async () => {
    const db = createMockDb();
    await persistSessionState(db as any, 'session_1', 'codex', null, null);

    const set = db._getSetValues();
    expect(Object.keys(set)).not.toContain('sdkSessionId');
  });

  it('updates both runtimeBackend and sdkSessionId when sdkSessionId is provided', async () => {
    const db = createMockDb();
    await persistSessionState(db as any, 'session_1', 'claude_code', 'sdk-sess-abc', null);

    const set = db._getSetValues();
    expect(set.runtimeBackend).toBe('claude_code');
    expect(set.sdkSessionId).toBe('sdk-sess-abc');
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it('does not overwrite existing sdkSessionId when codex runs', async () => {
    // When codex runs (sdkSessionId=null), the DB update must not include sdkSessionId
    // so the existing value in the DB is preserved (untouched by this update).
    const db = createMockDb();
    await persistSessionState(db as any, 'session_1', 'codex', null, null);

    const set = db._getSetValues();
    // sdkSessionId key must be absent — Drizzle only updates fields present in the set object
    expect('sdkSessionId' in set).toBe(false);
  });

  it('writes sdkSessionMachineId in lockstep with sdkSessionId (D15 remote substrate)', async () => {
    const db = createMockDb();
    await persistSessionState(db as any, 'session_1', 'claude_code', 'sdk-sess-abc', 'machine-1');

    const set = db._getSetValues();
    expect(set.sdkSessionId).toBe('sdk-sess-abc');
    expect(set.sdkSessionMachineId).toBe('machine-1');
  });

  it('omits sdkSessionMachineId when sdkSessionId is absent (no stale substrate write)', async () => {
    const db = createMockDb();
    // A machine id is passed but sdkSessionId is null: neither must be written so
    // the existing (sdkSessionId, sdkSessionMachineId) pair stays untouched.
    await persistSessionState(db as any, 'session_1', 'codex', null, 'machine-1');

    const set = db._getSetValues();
    expect('sdkSessionId' in set).toBe(false);
    expect('sdkSessionMachineId' in set).toBe(false);
  });

  it('writes NULL substrate for a server-local turn that produced an sdkSessionId', async () => {
    const db = createMockDb();
    await persistSessionState(db as any, 'session_1', 'claude_code', 'sdk-sess-local', null);

    const set = db._getSetValues();
    expect(set.sdkSessionId).toBe('sdk-sess-local');
    expect(set.sdkSessionMachineId).toBeNull();
  });
});
