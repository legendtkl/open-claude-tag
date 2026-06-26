import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '@open-tag/storage';
import { resolveIdentity, type IdentityAgentSource } from '../identity.js';

function makeAgent(overrides: Partial<IdentityAgentSource> = {}): IdentityAgentSource {
  return {
    id: 'agent-uuid-1',
    handle: 'open-claude-tag',
    profileId: 'profile-uuid-1',
    defaultRuntime: 'claude_code',
    scopeType: 'system',
    scopeId: 'default',
    status: 'active',
    ...overrides,
  };
}

describe('resolveIdentity', () => {
  it('composes an existing agent into a zero-access identity', () => {
    const identity = resolveIdentity(makeAgent());

    expect(identity.id).toBe('agent-uuid-1');
    // persona resolves to the agent's persisted profile (the existing persona source)
    expect(identity.persona).toEqual({ profileId: 'profile-uuid-1' });
    // runtimeBackend reuses the persisted runtime key, never re-derived
    expect(identity.runtimeBackend).toBe('claude_code');
    // active reflects the agent's status
    expect(identity.active).toBe(true);
    // zero-access by default: no access bundle, no declared budget
    expect(identity.accessBundleRef).toBeUndefined();
    expect(identity.budget).toBeUndefined();
    // boundChannels defaults to empty; memoryScopeId stays unset (never '')
    expect(identity.boundChannels).toEqual([]);
    expect(identity.memoryScopeId).toBeUndefined();
  });

  it('reflects an inactive / archived agent in `active`', () => {
    expect(resolveIdentity(makeAgent({ status: 'inactive' })).active).toBe(false);
    expect(resolveIdentity(makeAgent({ status: 'archived' })).active).toBe(false);
  });

  it('keys the identity by handle when options.id is the agent handle', () => {
    const agent = makeAgent();
    expect(resolveIdentity(agent, { id: agent.handle }).id).toBe('open-claude-tag');
  });

  it('falls back to claude_code only when the agent has no persisted runtime', () => {
    expect(resolveIdentity(makeAgent({ defaultRuntime: null })).runtimeBackend).toBe('claude_code');
    expect(
      resolveIdentity(makeAgent({ defaultRuntime: null }), { defaultRuntimeBackend: 'codex' })
        .runtimeBackend,
    ).toBe('codex');
    // a persisted runtime always wins over the fallback
    expect(
      resolveIdentity(makeAgent({ defaultRuntime: 'codex' }), {
        defaultRuntimeBackend: 'claude_code',
      }).runtimeBackend,
    ).toBe('codex');
  });

  it('binds channels and derives memoryScopeId from a sole unambiguous binding', () => {
    const identity = resolveIdentity(makeAgent(), {
      boundChannels: [{ kind: 'lark', scopeId: 'oc_chat_42' }],
    });

    expect(identity.boundChannels).toEqual([{ kind: 'lark', scopeId: 'oc_chat_42' }]);
    // memoryScopeId links to channel_observations.scopeId (the channel memory key)
    expect(identity.memoryScopeId).toBe('oc_chat_42');
  });

  it('does not guess memoryScopeId when multiple channels are bound (order-independent)', () => {
    const identity = resolveIdentity(makeAgent(), {
      boundChannels: [
        { kind: 'lark', scopeId: 'oc_chat_1' },
        { kind: 'lark', scopeId: 'oc_chat_2' },
      ],
    });

    expect(identity.memoryScopeId).toBeUndefined();
  });

  it('never yields an empty-string memoryScopeId (blank collapses to undefined)', () => {
    // a blank explicit key collapses to undefined (never a global memory bucket)
    expect(resolveIdentity(makeAgent(), { memoryScopeId: '' }).memoryScopeId).toBeUndefined();
    // a blank sole-binding scopeId likewise does not become a memory scope
    expect(
      resolveIdentity(makeAgent(), { boundChannels: [{ kind: 'lark', scopeId: '' }] }).memoryScopeId,
    ).toBeUndefined();
  });

  it('honors an explicit memoryScopeId over the bound-channel default', () => {
    const identity = resolveIdentity(makeAgent(), {
      boundChannels: [{ kind: 'lark', scopeId: 'oc_chat_1' }],
      memoryScopeId: 'oc_chat_override',
    });

    expect(identity.memoryScopeId).toBe('oc_chat_override');
  });

  it('carries an access bundle ref and declared budget when supplied', () => {
    const identity = resolveIdentity(makeAgent(), {
      accessBundleRef: 'bundle://jira-readonly',
      budget: { tokenCap: 1_000_000, window: 'day' },
    });

    expect(identity.accessBundleRef).toBe('bundle://jira-readonly');
    expect(identity.budget).toEqual({ tokenCap: 1_000_000, window: 'day' });
  });

  it('accepts a persona override (soul-loader directory string)', () => {
    const identity = resolveIdentity(makeAgent(), { persona: '/srv/souls/reviewer' });
    expect(identity.persona).toBe('/srv/souls/reviewer');
  });

  it('accepts a full drizzle AgentRecord as the source (read model over agents)', () => {
    // Compile-time proof that a persisted `agents` row is assignable to the Identity
    // source: Identity composes the agents table, it does not fork it.
    const asSource: IdentityAgentSource = {} as AgentRecord;
    void asSource;

    expect(true).toBe(true);
  });
});
