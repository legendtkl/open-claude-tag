import { describe, expect, it, vi } from 'vitest';
import {
  createEnvSecretProvider,
  type IdentityAccessGrant,
  type IdentityAgentSource,
} from '@open-tag/registry';
import { RemoteDispatchError } from '../remote-runtime-adapter.js';
import { resolveTaskCredentialEnv } from '../task-credential-injection.js';

// A dummy DB handle — the injected loadGrants ignores it, so unit tests never
// touch Postgres.
const db = {} as never;

function makeAgent(overrides: Partial<IdentityAgentSource> = {}): IdentityAgentSource {
  return {
    id: 'agent-1',
    handle: 'tag',
    profileId: 'profile-1',
    defaultRuntime: 'claude_code',
    scopeType: 'system',
    scopeId: 'default',
    status: 'active',
    ...overrides,
  };
}

const grantsOf = (...grants: IdentityAccessGrant[]) => async () => grants;

const JIRA_SECRETS = {
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'bot@example.com',
  JIRA_API_TOKEN: 'tok-secret',
};

describe('resolveTaskCredentialEnv', () => {
  it('merges the jira bundle env for an identity granted jira (server-local)', async () => {
    const env = await resolveTaskCredentialEnv(
      db,
      { agent: makeAgent({ id: 'agent-1' }), remoteDispatch: false },
      {
        loadGrants: grantsOf({ identityId: 'agent-1', bundleId: 'jira' }),
        secretProvider: createEnvSecretProvider(JIRA_SECRETS),
      },
    );

    expect(env).toEqual(JIRA_SECRETS);
  });

  it('returns an empty map for a zero-access identity (no grants), unchanged behavior', async () => {
    const loadGrants = vi.fn(grantsOf());
    const secretProvider = { getSecret: vi.fn(() => 'should-not-be-read') };

    const env = await resolveTaskCredentialEnv(
      db,
      { agent: makeAgent(), remoteDispatch: false },
      { loadGrants, secretProvider },
    );

    expect(env).toEqual({});
    // Zero-access fast path must not read any secret.
    expect(secretProvider.getSecret).not.toHaveBeenCalled();
  });

  it('skips a missing secret without injecting it (non-fatal), logs the name only', async () => {
    const warn = vi.fn();
    const env = await resolveTaskCredentialEnv(
      db,
      { agent: makeAgent({ id: 'agent-1' }), remoteDispatch: false },
      {
        loadGrants: grantsOf({ identityId: 'agent-1', bundleId: 'jira' }),
        // JIRA_API_TOKEN absent + JIRA_EMAIL empty → both treated as missing.
        secretProvider: createEnvSecretProvider({
          JIRA_BASE_URL: 'https://example.atlassian.net',
          JIRA_EMAIL: '',
        }),
        logger: { info: vi.fn(), warn },
      },
    );

    expect(env).toEqual({ JIRA_BASE_URL: 'https://example.atlassian.net' });
    expect(warn).toHaveBeenCalledTimes(1);
    const warnPayload = warn.mock.calls[0][0] as { missing: string[] };
    expect(warnPayload.missing).toEqual(expect.arrayContaining(['JIRA_EMAIL', 'JIRA_API_TOKEN']));
    // The skipped secret value must never appear in the result.
    expect(env.JIRA_EMAIL).toBeUndefined();
    expect(env.JIRA_API_TOKEN).toBeUndefined();
  });

  it('fail-fasts a remote-dispatched task that has a granted bundle (option a)', async () => {
    await expect(
      resolveTaskCredentialEnv(
        db,
        { agent: makeAgent({ id: 'agent-1' }), remoteDispatch: true },
        {
          loadGrants: grantsOf({ identityId: 'agent-1', bundleId: 'jira' }),
          secretProvider: createEnvSecretProvider(JIRA_SECRETS),
        },
      ),
    ).rejects.toBeInstanceOf(RemoteDispatchError);
  });

  it('fail-fasts a remote task with a grant EVEN when the server secret is missing', async () => {
    // The remote decision keys on the granted bundle, not on secret presence: a
    // missing server secret must not let a granted remote task run credential-less.
    const error = await resolveTaskCredentialEnv(
      db,
      { agent: makeAgent({ id: 'agent-1' }), remoteDispatch: true },
      {
        loadGrants: grantsOf({ identityId: 'agent-1', bundleId: 'jira' }),
        secretProvider: createEnvSecretProvider({}),
      },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteDispatchError);
    // The error message carries no secret value.
    expect((error as Error).message).not.toContain('tok-secret');
  });

  it('allows a remote-dispatched zero-access identity (no grant) to proceed', async () => {
    const env = await resolveTaskCredentialEnv(
      db,
      { agent: makeAgent(), remoteDispatch: true },
      { loadGrants: grantsOf() },
    );
    expect(env).toEqual({});
  });
});
