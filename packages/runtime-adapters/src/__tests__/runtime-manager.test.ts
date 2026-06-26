import { describe, it, expect, vi } from 'vitest';
import { RuntimeManager } from '../runtime-manager.js';
import type { RuntimeAdapter, HealthStatus } from '../types.js';

function mockAdapter(adapterName: string, healthy: boolean = true): RuntimeAdapter {
  return {
    name: () => adapterName,
    prepare: vi.fn(),
    execute: vi.fn(),
    cancel: vi.fn().mockResolvedValue('no_active_execution'),
    collectArtifacts: vi.fn(),
    healthcheck: vi.fn().mockResolvedValue({
      healthy,
      name: adapterName,
      lastCheckedAt: new Date(),
    } satisfies HealthStatus),
  } as unknown as RuntimeAdapter;
}

describe('RuntimeManager', () => {
  it('registers and retrieves adapters', () => {
    const manager = new RuntimeManager();
    const adapter = mockAdapter('test_runtime');
    manager.register(adapter);

    expect(manager.get('test_runtime')).toBe(adapter);
    expect(manager.get('nonexistent')).toBeUndefined();
  });

  it('lists registered adapters', () => {
    const manager = new RuntimeManager();
    manager.register(mockAdapter('claude_code'));
    manager.register(mockAdapter('codex'));

    expect(manager.listAdapters()).toEqual(['claude_code', 'codex']);
  });

  it('returns preferred healthy adapter', () => {
    const manager = new RuntimeManager();
    const claude = mockAdapter('claude_code');
    const codex = mockAdapter('codex');
    manager.register(claude);
    manager.register(codex);

    expect(manager.getHealthy('codex')).toBe(codex);
  });

  it('falls back to another adapter when preferred is unhealthy', async () => {
    const manager = new RuntimeManager();
    const claude = mockAdapter('claude_code', true);
    const codex = mockAdapter('codex', false);
    manager.register(claude);
    manager.register(codex);

    // Run health check to populate cache
    await manager.checkHealth();

    const result = manager.getHealthy('codex');
    expect(result).toBe(claude);
  });

  it('runs health checks', async () => {
    const manager = new RuntimeManager();
    const claude = mockAdapter('claude_code');
    manager.register(claude);

    const results = await manager.checkHealth();
    expect(results.size).toBe(1);
    expect(results.get('claude_code')?.healthy).toBe(true);
  });

  it('cancels a specific execution across registered adapters', async () => {
    const manager = new RuntimeManager();
    const claude = mockAdapter('claude_code');
    const codex = mockAdapter('codex');
    manager.register(claude);
    manager.register(codex);

    (codex.cancel as ReturnType<typeof vi.fn>).mockResolvedValueOnce('terminated');

    await expect(manager.cancel('task_123')).resolves.toBe('terminated');

    expect(claude.cancel).toHaveBeenCalledWith('task_123', {});
    expect(codex.cancel).toHaveBeenCalledWith('task_123', {});
  });

  it('returns termination_started when an adapter begins a child-backed termination path', async () => {
    const manager = new RuntimeManager();
    const claude = mockAdapter('claude_code');
    const codex = mockAdapter('codex');
    (codex.cancel as ReturnType<typeof vi.fn>).mockResolvedValueOnce('termination_started');
    manager.register(claude);
    manager.register(codex);

    await expect(manager.cancel('task_123')).resolves.toBe('termination_started');
  });

  it('rejects specific cancel when an adapter cancel fails', async () => {
    const manager = new RuntimeManager();
    const claude = mockAdapter('claude_code');
    const codex = mockAdapter('codex');
    (codex.cancel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('abort failed'));
    manager.register(claude);
    manager.register(codex);

    await expect(manager.cancel('task_123')).rejects.toThrow(
      'Runtime cancel failed for execution task_123',
    );
    expect(claude.cancel).toHaveBeenCalledWith('task_123', {});
    expect(codex.cancel).toHaveBeenCalledWith('task_123', {});
  });

  it('returns no_active_execution when no adapter owns the execution', async () => {
    const manager = new RuntimeManager();
    manager.register(mockAdapter('claude_code'));
    manager.register(mockAdapter('codex'));

    await expect(manager.cancel('task_123')).resolves.toBe('no_active_execution');
  });
});
