import { describe, it, expect, vi } from 'vitest';
import { ClaudeCodeAdapter, CLAUDE_CODE_DESCRIPTOR } from '../claude-code-adapter.js';
import { CodexAdapter, CODEX_DESCRIPTOR } from '../codex-adapter.js';
import {
  RUNTIME_DESCRIPTORS_BY_NAME,
  getRuntimeDescriptor,
} from '../runtime-descriptors.js';
import { buildRuntimeManager } from '../runtime-manager.js';
import type { RuntimeAdapter, RuntimeDescriptor } from '../types.js';
import { KNOWN_RUNTIME_NAMES } from '@open-tag/core-types';

describe('RuntimeDescriptor — per-adapter capabilities', () => {
  it('Claude Code: full-capability descriptor', () => {
    const adapter = new ClaudeCodeAdapter({ baseUrl: '', authToken: '' });
    const d = adapter.descriptor();
    expect(d).toBe(CLAUDE_CODE_DESCRIPTOR);
    expect(d.id).toBe('claude-code');
    expect(d.displayName).toBe('Claude Code');
    expect(d.capabilities).toEqual({
      resume: true,
      enforcesReadOnly: true,
      interactivePermission: true,
      sandboxModes: ['readonly', 'workspace-write', 'danger-full-access'],
      imageInput: 'base64',
      modelSelection: true,
    });
    expect(d.credentialEnv).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
    ]);
    expect(d.workflowPrompts).toEqual({
      selfDev: 'self-dev-claude',
      readonly: 'readonly',
      default: 'general-task',
    });
  });

  it('Codex: weaker readonly/permission than Claude, faithful to the adapter', () => {
    const adapter = new CodexAdapter();
    const d = adapter.descriptor();
    expect(d).toBe(CODEX_DESCRIPTOR);
    expect(d.id).toBe('codex');
    expect(d.displayName).toBe('Codex');
    // Codex resumes, but read-only is advisory and there is no interactive
    // per-tool permission — it runs headless `codex exec` at danger-full-access.
    expect(d.capabilities.resume).toBe(true);
    expect(d.capabilities.enforcesReadOnly).toBe(false);
    expect(d.capabilities.interactivePermission).toBe(false);
    expect(d.capabilities.sandboxModes).toEqual(['danger-full-access']);
    expect(d.capabilities.imageInput).toBe('local-path');
    expect(d.capabilities.modelSelection).toBe(true);
    expect(d.credentialEnv).toEqual(['CODEX_API_KEY', 'OPENAI_API_KEY']);
    expect(d.workflowPrompts?.selfDev).toBe('self-dev-codex');
  });
});

describe('persisted name() vs open descriptor().id are deliberately distinct', () => {
  // FIXTURE: pins the contract that the PERSISTED key (`name()`, written to
  // sessions.runtimeBackend) stays underscore `claude_code`, while the OPEN
  // display id (`descriptor().id`) is the hyphen form `claude-code`. These must
  // not be conflated — resume must keep matching the persisted underscore key.
  it('Claude Code: name() is claude_code (persisted), id is claude-code (open)', () => {
    const adapter = new ClaudeCodeAdapter({ baseUrl: '', authToken: '' });
    expect(adapter.name()).toBe('claude_code');
    expect(adapter.descriptor().id).toBe('claude-code');
    expect(adapter.name()).not.toBe(adapter.descriptor().id);
  });

  it('Codex: name() and id coincide (no underscore to translate)', () => {
    expect(new CodexAdapter().name()).toBe('codex');
    expect(new CodexAdapter().descriptor().id).toBe('codex');
  });

  it('descriptor lookup is keyed by the persisted name, not the open id', () => {
    expect(getRuntimeDescriptor('claude_code')).toBe(CLAUDE_CODE_DESCRIPTOR);
    expect(getRuntimeDescriptor('codex')).toBe(CODEX_DESCRIPTOR);
    // The open id is NOT a valid lookup key — only the persisted name resolves.
    expect(getRuntimeDescriptor('claude-code')).toBeUndefined();
    expect(getRuntimeDescriptor('unknown')).toBeUndefined();
    // Inherited Object.prototype members must NOT be treated as known runtimes
    // (callers use this for membership/validation, not just lookup).
    expect(getRuntimeDescriptor('toString')).toBeUndefined();
    expect(getRuntimeDescriptor('constructor')).toBeUndefined();
    expect(getRuntimeDescriptor('hasOwnProperty')).toBeUndefined();
    expect(Object.keys(RUNTIME_DESCRIPTORS_BY_NAME)).toEqual(['claude_code', 'codex']);
  });
});

describe('descriptor registry ↔ runtime-name SoT lockstep (#16)', () => {
  it('RUNTIME_DESCRIPTORS_BY_NAME keys deep-equal KNOWN_RUNTIME_NAMES', () => {
    // The SoT is the NAME list (underscore form). A descriptor must exist for
    // every known name and no extra descriptors may leak in. This guards against
    // a runtime being added to core-types' KNOWN_RUNTIME_NAMES without a matching
    // descriptor (or vice versa).
    expect(Object.keys(RUNTIME_DESCRIPTORS_BY_NAME)).toEqual([...KNOWN_RUNTIME_NAMES]);
  });

  it('keeps descriptor id (open, hyphen form) distinct from the persisted name', () => {
    // The SoT is the name list, NOT the descriptor id — they must not be
    // conflated. claude_code (name) ↔ claude-code (id) is the canonical example.
    expect(RUNTIME_DESCRIPTORS_BY_NAME.claude_code.id).toBe('claude-code');
    expect(RUNTIME_DESCRIPTORS_BY_NAME.claude_code.id).not.toBe('claude_code');
    expect((KNOWN_RUNTIME_NAMES as readonly string[]).includes('claude-code')).toBe(false);
  });
});

function fakeAdapter(adapterName: string): RuntimeAdapter {
  const descriptor: RuntimeDescriptor = {
    id: adapterName,
    displayName: adapterName,
    capabilities: {
      resume: false,
      enforcesReadOnly: false,
      interactivePermission: false,
      sandboxModes: ['danger-full-access'],
      imageInput: 'none',
      modelSelection: false,
    },
    credentialEnv: [],
  };
  return {
    name: () => adapterName,
    descriptor: () => descriptor,
    prepare: vi.fn(),
    execute: vi.fn(),
    cancel: vi.fn(),
    collectArtifacts: vi.fn(),
    healthcheck: vi.fn(),
    supportsResume: () => false,
    resume: vi.fn(),
  } as unknown as RuntimeAdapter;
}

describe('buildRuntimeManager — data-driven registration', () => {
  it('registers only available adapters and resolves them by name', () => {
    const createAvailable = vi.fn(() => fakeAdapter('alpha'));
    const createUnavailable = vi.fn(() => fakeAdapter('beta'));

    const manager = buildRuntimeManager([
      { isAvailable: () => true, create: createAvailable },
      { isAvailable: () => false, create: createUnavailable },
    ]);

    // Only the available registration is constructed and registered.
    expect(createAvailable).toHaveBeenCalledTimes(1);
    expect(createUnavailable).not.toHaveBeenCalled();
    expect(manager.listAdapters()).toEqual(['alpha']);
    expect(manager.get('alpha')?.name()).toBe('alpha');
    expect(manager.get('beta')).toBeUndefined();
  });

  it('produces an empty manager when nothing is available', () => {
    const manager = buildRuntimeManager([
      { isAvailable: () => false, create: () => fakeAdapter('x') },
    ]);
    expect(manager.listAdapters()).toEqual([]);
  });

  it('preserves registration order for multiple available adapters', () => {
    const manager = buildRuntimeManager([
      { isAvailable: () => true, create: () => fakeAdapter('claude_code') },
      { isAvailable: () => true, create: () => fakeAdapter('codex') },
    ]);
    expect(manager.listAdapters()).toEqual(['claude_code', 'codex']);
  });
});
