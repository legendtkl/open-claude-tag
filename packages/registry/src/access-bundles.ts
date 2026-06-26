import type { Identity } from './identity.js';

/**
 * A named, versioned access bundle — a jira/datadog-style "plugin" an identity can
 * install. The bundle declares the set of credential env-var NAMES it injects into
 * the runtime process at execution time; the VALUES are never carried here (they are
 * read from a {@link SecretProvider} at execution time — see `access-injection.ts`).
 *
 * Mirrors the data-driven {@link RuntimeDescriptor} pattern: a `RuntimeDescriptor`
 * lists the `credentialEnv` a runtime reads; an `AccessBundle` lists the
 * `credentialEnv` a plugin contributes. Names only, never secrets.
 */
export interface AccessBundle {
  /** Open bundle id (e.g. `jira`, `datadog`). The marketplace lookup key. */
  id: string;
  /** Bundle version. Bumped when the declared `credentialEnv`/`scopes` change. */
  version: string;
  /** Human label for the console / cards. */
  displayName: string;
  /**
   * Credential env-var NAMES this bundle injects (e.g. `JIRA_API_TOKEN`). Names
   * only — values come from a secret provider at execution time and are never
   * stored on the bundle. Each name MUST be a valid, non-dangerous credential env
   * name (see `isCredentialEnvName`) AND fall under one of {@link envPrefixes}; the
   * seed registry is test-pinned to both.
   */
  credentialEnv: string[];
  /**
   * The env-var name prefixes this bundle is allowed to inject (e.g. `['JIRA_']`).
   * A declared {@link credentialEnv} name is injectable ONLY when it is a STRICT
   * prefix-match (longer than, and starting with) one of these prefixes. This makes
   * a bundle a hard credential NAMESPACE: it can never inject an env var outside its
   * own surface, which a denylist alone cannot guarantee. An empty list, an
   * empty-string prefix, or a name equal to the prefix injects nothing.
   */
  envPrefixes: string[];
  /** Capability scopes this bundle grants (metadata, e.g. `issues:read`). */
  scopes: string[];
}

/**
 * A single identity→bundle installation link. One row per installed bundle, so it
 * maps cleanly onto a future `identity_access_grants` table. Grants are an INJECTED
 * source: callers pass them to {@link resolveIdentityAccess}; DB persistence is a
 * deferred follow-up and does not change this shape.
 */
export interface IdentityAccessGrant {
  /** The {@link Identity.id} this grant belongs to. */
  identityId: string;
  /** The {@link AccessBundle.id} this identity has installed. */
  bundleId: string;
}

const JIRA_BUNDLE: AccessBundle = {
  id: 'jira',
  version: '1',
  displayName: 'Jira',
  credentialEnv: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
  envPrefixes: ['JIRA_'],
  scopes: ['issues:read', 'issues:write'],
};

const DATADOG_BUNDLE: AccessBundle = {
  id: 'datadog',
  version: '1',
  displayName: 'Datadog',
  credentialEnv: ['DATADOG_API_KEY', 'DATADOG_APP_KEY'],
  envPrefixes: ['DATADOG_'],
  scopes: ['metrics:read', 'monitors:read'],
};

/**
 * The closed seed marketplace of access bundles, keyed by {@link AccessBundle.id}.
 * Adding a bundle touches only this file (mirrors `RUNTIME_DESCRIPTORS_BY_NAME`).
 * The id is an open string, but the seed set is closed and {@link getAccessBundle}
 * is hardened against inherited prototype keys.
 */
export const ACCESS_BUNDLES_BY_ID: Readonly<Record<string, AccessBundle>> = {
  jira: JIRA_BUNDLE,
  datadog: DATADOG_BUNDLE,
};

/**
 * Resolve a bundle by id. Returns undefined for unknown ids. Uses an own-key check
 * so inherited `Object.prototype` members (`toString`, `constructor`, …) are never
 * mistaken for a registered bundle — callers rely on this for membership/validation,
 * not just lookup.
 */
export function getAccessBundle(id: string): AccessBundle | undefined {
  return Object.hasOwn(ACCESS_BUNDLES_BY_ID, id) ? ACCESS_BUNDLES_BY_ID[id] : undefined;
}

/**
 * Compose the access bundles an identity has installed from its grants.
 *
 * Zero-access default: an identity with no applicable grant resolves to `[]` — no
 * plugins, no credentials. Order is first-grant order; duplicate grants for the same
 * bundle collapse to one entry.
 *
 * Fail-closed: grants are FILTERED to `identity.id` FIRST, then each applicable
 * bundle id is resolved. An applicable grant referencing an unknown bundle id throws
 * (a real misconfiguration is surfaced loudly rather than silently under-granting).
 * Grants belonging to OTHER identities are ignored and never resolved, so one
 * identity's stale/unknown grant can never break another identity's resolution.
 *
 * Pure and deterministic: no DB I/O, no wall-clock.
 */
export function resolveIdentityAccess(
  identity: Pick<Identity, 'id'>,
  grants: IdentityAccessGrant[],
): AccessBundle[] {
  const seen = new Set<string>();
  const resolved: AccessBundle[] = [];

  for (const grant of grants) {
    if (grant.identityId !== identity.id) continue;
    if (seen.has(grant.bundleId)) continue;
    seen.add(grant.bundleId);

    const bundle = getAccessBundle(grant.bundleId);
    if (!bundle) {
      throw new Error(
        `resolveIdentityAccess: identity "${identity.id}" is granted unknown access bundle "${grant.bundleId}"`,
      );
    }
    resolved.push(bundle);
  }

  return resolved;
}
