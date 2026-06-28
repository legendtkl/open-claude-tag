import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapter } from '@open-tag/runtime-adapters';
import { selectLocalRuntimeAdapter, type LocalRuntimeSelector } from '../runtime-selection.js';

const claudeAdapter = { name: () => 'claude_code' } as unknown as RuntimeAdapter;
const codexAdapter = { name: () => 'codex' } as unknown as RuntimeAdapter;

describe('selectLocalRuntimeAdapter', () => {
  it('uses requireHealthy for an explicit selection and never falls back', async () => {
    const requireHealthy = vi.fn().mockResolvedValue(codexAdapter);
    const getHealthyFallback = vi.fn();
    const manager: LocalRuntimeSelector = { requireHealthy, getHealthyFallback };

    const result = await selectLocalRuntimeAdapter(manager, 'codex', true);

    expect(result.adapter).toBe(codexAdapter);
    expect(result.fallback).toBeNull();
    expect(requireHealthy).toHaveBeenCalledWith('codex');
    expect(getHealthyFallback).not.toHaveBeenCalled();
  });

  it('propagates the requireHealthy error for an unavailable explicit runtime', async () => {
    const requireHealthy = vi
      .fn()
      .mockRejectedValue(new Error('Requested runtime "codex" is unavailable: no creds'));
    const getHealthyFallback = vi.fn();
    const manager: LocalRuntimeSelector = { requireHealthy, getHealthyFallback };

    await expect(selectLocalRuntimeAdapter(manager, 'codex', true)).rejects.toThrow(
      /Requested runtime "codex" is unavailable/,
    );
    expect(getHealthyFallback).not.toHaveBeenCalled();
  });

  it('uses getHealthyFallback for a non-explicit selection and reports no fallback when satisfied', async () => {
    const requireHealthy = vi.fn();
    const getHealthyFallback = vi.fn().mockResolvedValue({
      adapter: codexAdapter,
      requested: 'codex',
      selected: 'codex',
      usedFallback: false,
    });
    const manager: LocalRuntimeSelector = { requireHealthy, getHealthyFallback };

    const result = await selectLocalRuntimeAdapter(manager, 'codex', false);

    expect(result.adapter).toBe(codexAdapter);
    expect(result.fallback).toBeNull();
    expect(requireHealthy).not.toHaveBeenCalled();
  });

  it('surfaces the fallback record (preferred + fallback + reason) for a non-explicit substitution', async () => {
    const getHealthyFallback = vi.fn().mockResolvedValue({
      adapter: claudeAdapter,
      requested: 'codex',
      selected: 'claude_code',
      usedFallback: true,
      reason: 'requested runtime "codex" is unhealthy: no creds',
    });
    const manager: LocalRuntimeSelector = {
      requireHealthy: vi.fn(),
      getHealthyFallback,
    };

    const result = await selectLocalRuntimeAdapter(manager, 'codex', false);

    expect(result.adapter).toBe(claudeAdapter);
    expect(result.fallback).toEqual({
      preferredRuntime: 'codex',
      fallbackRuntime: 'claude_code',
      reason: 'requested runtime "codex" is unhealthy: no creds',
    });
  });

  it('throws when no runtime is available for a non-explicit selection', async () => {
    const manager: LocalRuntimeSelector = {
      requireHealthy: vi.fn(),
      getHealthyFallback: vi.fn().mockResolvedValue(undefined),
    };

    await expect(selectLocalRuntimeAdapter(manager, 'codex', false)).rejects.toThrow(
      'No healthy runtime adapter available',
    );
  });
});
