import { describe, expect, it } from 'vitest';
import type { AccessBundle } from '../access-bundles.js';
import {
  buildInjectedCredentialEnv,
  createEnvSecretProvider,
  isCredentialEnvName,
  type SecretProvider,
} from '../access-injection.js';

/** Derive a default `<NAMESPACE>_` prefix per name so test bundles auto-namespace. */
function prefixesFor(names: string[]): string[] {
  return [...new Set(names.map((n) => (n.includes('_') ? n.slice(0, n.indexOf('_') + 1) : n)))];
}

function bundle(
  id: string,
  credentialEnv: string[],
  envPrefixes: string[] = prefixesFor(credentialEnv),
): AccessBundle {
  return { id, version: '1', displayName: id, credentialEnv, envPrefixes, scopes: [] };
}

/** A {@link SecretProvider} backed by an explicit in-test map (no process.env). */
function mapProvider(values: Record<string, string | undefined>): SecretProvider {
  return createEnvSecretProvider(values);
}

describe('isCredentialEnvName — validation', () => {
  it('accepts conventional upper-snake credential names', () => {
    expect(isCredentialEnvName('JIRA_API_TOKEN')).toBe(true);
    expect(isCredentialEnvName('_PRIVATE')).toBe(true);
    expect(isCredentialEnvName('DATADOG_APP_KEY')).toBe(true);
  });

  it('rejects malformed names', () => {
    expect(isCredentialEnvName('')).toBe(false);
    expect(isCredentialEnvName('lower_case')).toBe(false);
    expect(isCredentialEnvName('1LEADING_DIGIT')).toBe(false);
    expect(isCredentialEnvName('HAS-DASH')).toBe(false);
    expect(isCredentialEnvName('HAS SPACE')).toBe(false);
  });

  it('rejects process-hijack / loader vectors even though they look conventional', () => {
    for (const dangerous of ['PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH']) {
      expect(isCredentialEnvName(dangerous)).toBe(false);
    }
  });
});

describe('buildInjectedCredentialEnv — runtime credential injection seam', () => {
  it('invariant (a): injects ONLY names declared by the given bundles', () => {
    const result = buildInjectedCredentialEnv(
      [bundle('jira', ['JIRA_API_TOKEN'])],
      mapProvider({ JIRA_API_TOKEN: 't', UNRELATED_SECRET: 'nope' }),
    );
    expect(result.env).toEqual({ JIRA_API_TOKEN: 't' });
    expect(result.injected).toEqual(['JIRA_API_TOKEN']);
    // an ambient secret not declared by any bundle is never injected
    expect(result.env).not.toHaveProperty('UNRELATED_SECRET');
  });

  it('invariant (b): a missing secret is skipped and signaled, never injected', () => {
    const result = buildInjectedCredentialEnv(
      [bundle('jira', ['JIRA_API_TOKEN'])],
      mapProvider({}),
    );
    expect(result.env).toEqual({});
    expect(result.injected).toEqual([]);
    expect(result.missing).toEqual(['JIRA_API_TOKEN']);
  });

  it('invariant (b): an empty-string secret is treated exactly like undefined (missing)', () => {
    const result = buildInjectedCredentialEnv(
      [bundle('jira', ['JIRA_API_TOKEN', 'JIRA_EMAIL'])],
      mapProvider({ JIRA_API_TOKEN: '', JIRA_EMAIL: undefined }),
    );
    expect(result.env).toEqual({});
    expect(result.missing).toEqual(['JIRA_API_TOKEN', 'JIRA_EMAIL']);
  });

  it('invariant (c): secret VALUES live only in env; injected/missing/rejected are names only', () => {
    const result = buildInjectedCredentialEnv(
      [bundle('jira', ['JIRA_API_TOKEN', 'JIRA_EMAIL'])],
      mapProvider({ JIRA_API_TOKEN: 'super-secret-value', JIRA_EMAIL: '' }),
    );
    const serializedSignals = JSON.stringify({
      injected: result.injected,
      missing: result.missing,
      rejected: result.rejected,
    });
    expect(serializedSignals).not.toContain('super-secret-value');
    // the value only ever appears in the env map
    expect(result.env.JIRA_API_TOKEN).toBe('super-secret-value');
  });

  it('dedupes a credential name declared by multiple bundles (first-seen order)', () => {
    const provider = mapProvider({ SHARED_TOKEN: 'v', DATADOG_API_KEY: 'd' });
    const result = buildInjectedCredentialEnv(
      [bundle('a', ['SHARED_TOKEN']), bundle('b', ['SHARED_TOKEN', 'DATADOG_API_KEY'])],
      provider,
    );
    expect(result.injected).toEqual(['SHARED_TOKEN', 'DATADOG_API_KEY']);
    expect(result.env).toEqual({ SHARED_TOKEN: 'v', DATADOG_API_KEY: 'd' });
  });

  it('rejects a dangerous declared name and never injects it, even if a value exists', () => {
    const result = buildInjectedCredentialEnv(
      [bundle('evil', ['PATH', 'JIRA_API_TOKEN'])],
      mapProvider({ PATH: '/attacker/bin', JIRA_API_TOKEN: 't' }),
    );
    expect(result.env).toEqual({ JIRA_API_TOKEN: 't' });
    expect(result.rejected).toEqual(['PATH']);
    expect(result.injected).toEqual(['JIRA_API_TOKEN']);
  });

  it('namespace guard: rejects a declared name outside the bundle envPrefixes', () => {
    // Even a well-formed, non-dangerous, value-bearing name is rejected when it
    // escapes the bundle's own credential namespace — bundles cannot reach env
    // vars (e.g. another tool's, or execution-control vars) outside their prefix.
    const result = buildInjectedCredentialEnv(
      [bundle('jira', ['JIRA_API_TOKEN', 'GIT_SSH_COMMAND', 'DATADOG_API_KEY'], ['JIRA_'])],
      mapProvider({ JIRA_API_TOKEN: 't', GIT_SSH_COMMAND: 'ssh -i /x', DATADOG_API_KEY: 'd' }),
    );
    expect(result.env).toEqual({ JIRA_API_TOKEN: 't' });
    expect(result.injected).toEqual(['JIRA_API_TOKEN']);
    expect(result.rejected).toEqual(['GIT_SSH_COMMAND', 'DATADOG_API_KEY']);
  });

  it('namespace guard: an empty-string prefix never grants (injects nothing)', () => {
    const result = buildInjectedCredentialEnv(
      [bundle('loose', ['JIRA_API_TOKEN'], [''])],
      mapProvider({ JIRA_API_TOKEN: 't' }),
    );
    expect(result.env).toEqual({});
    expect(result.rejected).toEqual(['JIRA_API_TOKEN']);
  });

  it('namespace guard: a bare name equal to the prefix (no suffix) is rejected', () => {
    const result = buildInjectedCredentialEnv(
      [bundle('jira', ['JIRA_'], ['JIRA_'])],
      mapProvider({ JIRA_: 'x' }),
    );
    expect(result.env).toEqual({});
    expect(result.rejected).toEqual(['JIRA_']);
  });

  it('zero bundles yields an empty injection (zero-access default)', () => {
    const result = buildInjectedCredentialEnv([], mapProvider({ ANYTHING: 'x' }));
    expect(result).toEqual({ env: {}, injected: [], missing: [], rejected: [] });
  });

  it('seam shape: result.env merges into an ambient runtimeEnv with injected winning', () => {
    // Pins the intended call-site precedence (Object.assign(runtimeEnv, result.env)):
    // injected credentials override ambient values, matching the adapter rule.
    const { env } = buildInjectedCredentialEnv(
      [bundle('jira', ['JIRA_API_TOKEN'])],
      mapProvider({ JIRA_API_TOKEN: 'fresh' }),
    );
    const runtimeEnv: Record<string, string> = { JIRA_API_TOKEN: 'stale', OTHER: 'keep' };
    Object.assign(runtimeEnv, env);
    expect(runtimeEnv).toEqual({ JIRA_API_TOKEN: 'fresh', OTHER: 'keep' });
  });
});

describe('createEnvSecretProvider — default secret source', () => {
  it('reads from a passed map and returns undefined for absent names', () => {
    const provider = createEnvSecretProvider({ A: '1' });
    expect(provider.getSecret('A')).toBe('1');
    expect(provider.getSecret('B')).toBeUndefined();
  });

  it('does not surface inherited prototype keys as secrets', () => {
    const provider = createEnvSecretProvider({});
    expect(provider.getSecret('toString')).toBeUndefined();
    expect(provider.getSecret('constructor')).toBeUndefined();
  });

  it('defaults to process.env when no source is passed', () => {
    const prev = process.env.OPEN_TAG_TEST_SECRET;
    process.env.OPEN_TAG_TEST_SECRET = 'env-value';
    try {
      expect(createEnvSecretProvider().getSecret('OPEN_TAG_TEST_SECRET')).toBe('env-value');
    } finally {
      if (prev === undefined) delete process.env.OPEN_TAG_TEST_SECRET;
      else process.env.OPEN_TAG_TEST_SECRET = prev;
    }
  });
});
