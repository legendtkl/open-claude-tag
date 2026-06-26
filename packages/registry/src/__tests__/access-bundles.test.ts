import { describe, expect, it } from 'vitest';
import {
  ACCESS_BUNDLES_BY_ID,
  getAccessBundle,
  resolveIdentityAccess,
  type IdentityAccessGrant,
} from '../access-bundles.js';
import { isCredentialEnvName } from '../access-injection.js';

describe('getAccessBundle — marketplace lookup hardening', () => {
  it('resolves seed bundles by id', () => {
    expect(getAccessBundle('jira')).toBe(ACCESS_BUNDLES_BY_ID.jira);
    expect(getAccessBundle('datadog')).toBe(ACCESS_BUNDLES_BY_ID.datadog);
  });

  it('returns undefined for unknown ids', () => {
    expect(getAccessBundle('slack')).toBeUndefined();
    expect(getAccessBundle('')).toBeUndefined();
  });

  it('never treats inherited Object.prototype members as registered bundles', () => {
    expect(getAccessBundle('toString')).toBeUndefined();
    expect(getAccessBundle('constructor')).toBeUndefined();
    expect(getAccessBundle('hasOwnProperty')).toBeUndefined();
    expect(Object.keys(ACCESS_BUNDLES_BY_ID)).toEqual(['jira', 'datadog']);
  });

  it('every seed bundle declares only valid credential names within its namespace', () => {
    // Pins the marketplace itself clean: the registry can never become an
    // env-override channel through a seed bundle. Every declared name must be a
    // valid, non-dangerous env name AND fall under one of the bundle's prefixes.
    for (const bundle of Object.values(ACCESS_BUNDLES_BY_ID)) {
      expect(bundle.credentialEnv.length).toBeGreaterThan(0);
      expect(bundle.envPrefixes.length).toBeGreaterThan(0);
      for (const name of bundle.credentialEnv) {
        expect(isCredentialEnvName(name)).toBe(true);
        expect(bundle.envPrefixes.some((p) => p.length > 0 && name.startsWith(p))).toBe(true);
      }
    }
  });
});

describe('resolveIdentityAccess — compose installed bundles', () => {
  const identity = { id: 'identity-1' };

  it('zero-access by default: no grants resolves to an empty list', () => {
    expect(resolveIdentityAccess(identity, [])).toEqual([]);
  });

  it('resolves only grants belonging to the identity', () => {
    const grants: IdentityAccessGrant[] = [
      { identityId: 'identity-1', bundleId: 'jira' },
      { identityId: 'identity-OTHER', bundleId: 'datadog' },
    ];
    const resolved = resolveIdentityAccess(identity, grants);
    expect(resolved.map((b) => b.id)).toEqual(['jira']);
  });

  it('dedupes duplicate grants for the same bundle (first-seen order)', () => {
    const grants: IdentityAccessGrant[] = [
      { identityId: 'identity-1', bundleId: 'datadog' },
      { identityId: 'identity-1', bundleId: 'jira' },
      { identityId: 'identity-1', bundleId: 'datadog' },
    ];
    const resolved = resolveIdentityAccess(identity, grants);
    expect(resolved.map((b) => b.id)).toEqual(['datadog', 'jira']);
  });

  it('fails fast on an APPLICABLE grant referencing an unknown bundle', () => {
    const grants: IdentityAccessGrant[] = [{ identityId: 'identity-1', bundleId: 'ghost' }];
    expect(() => resolveIdentityAccess(identity, grants)).toThrow(/unknown access bundle "ghost"/);
  });

  it('ignores an unknown bundle granted to a DIFFERENT identity (never resolved)', () => {
    // A stale/unknown grant for another identity must not break this resolution.
    const grants: IdentityAccessGrant[] = [
      { identityId: 'identity-OTHER', bundleId: 'ghost' },
      { identityId: 'identity-1', bundleId: 'jira' },
    ];
    expect(resolveIdentityAccess(identity, grants).map((b) => b.id)).toEqual(['jira']);
  });
});
