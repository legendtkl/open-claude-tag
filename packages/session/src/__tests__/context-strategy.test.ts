import { describe, it, expect } from 'vitest';
import { selectContextStrategy } from '../context-strategy.js';

const base = {
  stored: {
    sdkSessionId: 'sess-1',
    agentId: 'agent-a',
    runtimeBackend: 'claude_code',
    machineId: null,
  },
  next: { agentId: 'agent-a', runtimeBackend: 'claude_code', machineId: null },
  adapterSupportsResume: true,
};

describe('selectContextStrategy', () => {
  it('resumes for same agent and kind on same (server-local) machine', () => {
    expect(selectContextStrategy(base).mode).toBe('resume');
  });

  it('resumes for same agent and kind on the same remote machine', () => {
    const r = selectContextStrategy({
      ...base,
      stored: { ...base.stored, machineId: 'm1' },
      next: { agentId: 'agent-a', runtimeBackend: 'claude_code', machineId: 'm1' },
    });
    expect(r.mode).toBe('resume');
  });

  it('hydrates when the agent differs even on the same machine', () => {
    const r = selectContextStrategy({
      ...base,
      next: { agentId: 'agent-b', runtimeBackend: 'claude_code', machineId: null },
    });
    expect(r.mode).toBe('hydrate');
    expect(r.reason).toMatch(/agent changed/);
  });

  it('hydrates when the runtime kind differs', () => {
    const r = selectContextStrategy({
      ...base,
      next: { agentId: 'agent-a', runtimeBackend: 'codex', machineId: null },
    });
    expect(r.mode).toBe('hydrate');
    expect(r.reason).toMatch(/runtime kind changed/);
  });

  it('hydrates when the machine differs', () => {
    const r = selectContextStrategy({
      ...base,
      stored: { ...base.stored, machineId: 'm1' },
      next: { agentId: 'agent-a', runtimeBackend: 'claude_code', machineId: 'm2' },
    });
    expect(r.mode).toBe('hydrate');
    expect(r.reason).toMatch(/machine changed/);
  });

  it('hydrates when server-local moves to a remote machine', () => {
    const r = selectContextStrategy({
      ...base,
      stored: { ...base.stored, machineId: null },
      next: { agentId: 'agent-a', runtimeBackend: 'claude_code', machineId: 'm1' },
    });
    expect(r.mode).toBe('hydrate');
  });

  it('resumes when the stored kind is legacy-null and the next runtime is Claude Code', () => {
    const r = selectContextStrategy({
      ...base,
      stored: { sdkSessionId: 'sess-1', runtimeBackend: null, machineId: null },
      next: { runtimeBackend: 'claude_code', machineId: null },
    });
    expect(r.mode).toBe('resume');
  });

  it('hydrates when the stored kind is legacy-null and the next runtime is not Claude Code', () => {
    const r = selectContextStrategy({
      ...base,
      stored: { sdkSessionId: 'sess-1', runtimeBackend: null, machineId: null },
      next: { runtimeBackend: 'codex', machineId: null },
    });
    expect(r.mode).toBe('hydrate');
    expect(r.reason).toMatch(/runtime kind changed: claude_code/);
  });

  it('hydrates when there is no stored SDK session', () => {
    const r = selectContextStrategy({
      ...base,
      stored: { sdkSessionId: null, runtimeBackend: 'claude_code', machineId: null },
    });
    expect(r.mode).toBe('hydrate');
    expect(r.reason).toMatch(/no stored SDK session/);
  });

  it('hydrates when the adapter does not support resume', () => {
    const r = selectContextStrategy({ ...base, adapterSupportsResume: false });
    expect(r.mode).toBe('hydrate');
    expect(r.reason).toMatch(/does not support resume/);
  });
});
