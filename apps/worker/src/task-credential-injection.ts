import {
  buildInjectedCredentialEnv,
  createEnvSecretProvider,
  loadIdentityAccessGrants as defaultLoadGrants,
  resolveIdentity,
  resolveIdentityAccess,
  type IdentityAccessGrant,
  type IdentityAgentSource,
  type SecretProvider,
} from '@open-tag/registry';
import type { Database } from '@open-tag/storage';
import type { Logger } from 'pino';
import { RemoteDispatchError } from './remote-runtime-adapter.js';

/**
 * Resolve the access-bundle credential env to merge into a task's SERVER-LOCAL
 * runtime process env.
 *
 * The execution-time half of the access-bundles vertical: it composes the running
 * identity (the SAME `resolveIdentity` path the budget gate / `recordTaskUsage`
 * compose, so the id grants are keyed under is the id the runtime runs as), loads
 * its installed grants, resolves them to bundles, and reads each declared
 * credential's VALUE from a {@link SecretProvider}. The returned map is meant to be
 * `Object.assign`-ed onto the worker's `runtimeEnv` (injected credentials WIN over
 * ambient/global env, per the adapter precedence rule).
 *
 * Zero-access default: an identity with no grants resolves to no bundles and an
 * empty map WITHOUT reading any secret — server-local behavior is unchanged.
 *
 * SECURITY / fail-closed policy:
 *  - `remoteDispatch` (machine-bound task): credential forwarding across the daemon
 *    boundary is not built yet, so a task whose identity has ANY granted bundle
 *    fail-fasts with {@link RemoteDispatchError} rather than running remotely
 *    WITHOUT the creds it was granted. The decision keys on the resolved bundle
 *    count, NOT on whether the server happens to hold the secret — a missing/empty
 *    server secret must not let a granted remote task slip through credential-less.
 *  - `rejected` (a declared name fell outside its bundle's namespace / failed the
 *    format guard): a real bundle misconfiguration. Thrown, never silently dropped,
 *    so a bundle can never quietly under-provision. The seed marketplace is pinned
 *    so this never fires for it.
 *  - `missing` (a declared secret is absent/empty on this server): a non-fatal
 *    OPERATIONAL gap — the credential is simply not injected. Logged by NAME so an
 *    operator can provision it, but it does not fail the task (no wrong/stale value
 *    is ever injected, so this is not a security hole). Matches the addressed-task
 *    fail-open stance the budget admission gate takes for infra gaps.
 *
 * Never logs or returns a secret VALUE: only env-var NAMES and bundle ids appear in
 * logs and in the thrown error message.
 */
export interface ResolveTaskCredentialEnvInput {
  /** The agent the task runs as; composed into the identity grants are keyed under. */
  agent: IdentityAgentSource;
  /** True when the task is dispatched to a remote machine (see fail-fast policy). */
  remoteDispatch: boolean;
}

export interface ResolveTaskCredentialEnvDeps {
  /**
   * Load an identity's grants. Injectable so unit tests never touch the DB; defaults
   * to the registry `loadIdentityAccessGrants` (reads `identity_access_grants`).
   */
  loadGrants?: (db: Database, identityId: string) => Promise<IdentityAccessGrant[]>;
  /**
   * Source of credential VALUES by name. Defaults to a process-env provider (the
   * deployment supplies the real secrets); tests pass a scoped map.
   */
  secretProvider?: SecretProvider;
  /** Optional logger for NAMES-only diagnostics. Never receives a secret value. */
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export async function resolveTaskCredentialEnv(
  db: Database,
  input: ResolveTaskCredentialEnvInput,
  deps: ResolveTaskCredentialEnvDeps = {},
): Promise<Record<string, string>> {
  const identity = resolveIdentity(input.agent);
  const loadGrants = deps.loadGrants ?? defaultLoadGrants;
  const grants = await loadGrants(db, identity.id);
  const bundles = resolveIdentityAccess(identity, grants);

  // Zero-access fast path: no grants ⇒ no bundles ⇒ inject nothing, read no secret.
  if (bundles.length === 0) return {};

  // Fail-fast on remote dispatch: a machine-bound task with granted bundles must
  // not run remotely without the creds it was granted, and forwarding them across
  // the daemon boundary is a follow-up. Keyed on bundle count, not on whether the
  // server holds the secret (a missing server secret must not slip a granted task
  // through). The generic message carries no secret value.
  if (input.remoteDispatch) {
    throw new RemoteDispatchError(
      'Access-bundle credentials cannot be injected into a remote runtime yet; ' +
        'run this task server-local or remove the access-bundle grant.',
    );
  }

  const secretProvider = deps.secretProvider ?? createEnvSecretProvider();
  const result = buildInjectedCredentialEnv(bundles, secretProvider);

  // A rejected name means a bundle declared an env var outside its own namespace
  // (or a dangerous/invalid name) — a misconfiguration, surfaced loudly.
  if (result.rejected.length > 0) {
    throw new Error(
      `Access bundle declared credential env names outside their namespace: ${result.rejected.join(', ')}`,
    );
  }

  if (result.missing.length > 0) {
    deps.logger?.warn(
      { identityId: identity.id, missing: result.missing },
      'Access-bundle credential(s) not provisioned on this server; skipping injection',
    );
  }
  if (result.injected.length > 0) {
    deps.logger?.info(
      { identityId: identity.id, injected: result.injected },
      'Injected access-bundle credential(s) into the runtime env',
    );
  }

  return result.env;
}
