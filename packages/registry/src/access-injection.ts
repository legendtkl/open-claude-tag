import type { AccessBundle } from './access-bundles.js';

/**
 * A source of credential VALUES, looked up by env-var name. Injected dependency so
 * the runtime-env composer never reaches for a concrete secret store: the default
 * impl reads from a plain map (process env or a passed map); a real deployment can
 * swap in a vault-backed provider without changing the composer.
 *
 * `getSecret` returns `undefined` when the secret is not provisioned. It must NEVER
 * throw for a missing secret — absence is a normal, signaled outcome (see
 * {@link buildInjectedCredentialEnv}).
 */
export interface SecretProvider {
  getSecret(name: string): string | undefined;
}

/**
 * Default {@link SecretProvider}: reads secret values from a plain string map,
 * defaulting to `process.env`. No vault dependency, no hardcoded secrets. Pass an
 * explicit map in tests or to scope the readable surface.
 */
export function createEnvSecretProvider(
  source: Record<string, string | undefined> = process.env,
): SecretProvider {
  return {
    getSecret(name: string): string | undefined {
      return Object.hasOwn(source, name) ? source[name] : undefined;
    },
  };
}

/**
 * Env names that must NEVER be injectable through a bundle. These are
 * process-hijack / loader vectors: letting a bundle set them would turn credential
 * injection into an arbitrary-env-override (and code-execution) channel. A bundle
 * declaring any of these has its name rejected, not injected.
 */
const DANGEROUS_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'IFS',
  'ENV',
  'BASH_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

const CREDENTIAL_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Whether `name` is a valid, injectable credential env-var name: a conventional
 * upper-snake env name that is NOT a process-hijack vector (see
 * {@link DANGEROUS_ENV_NAMES}). This is the FORMAT baseline only; the primary guard
 * against a bundle becoming an env-override channel is the per-bundle namespace
 * (`AccessBundle.envPrefixes`) enforced in {@link buildInjectedCredentialEnv}. The
 * seed marketplace is test-pinned to satisfy both.
 */
export function isCredentialEnvName(name: string): boolean {
  return CREDENTIAL_ENV_NAME_PATTERN.test(name) && !DANGEROUS_ENV_NAMES.has(name);
}

/**
 * Result of {@link buildInjectedCredentialEnv}.
 *
 * SECURITY: `env` is the ONLY secret-bearing field — it maps env-var name → secret
 * VALUE and is meant to be merged into the runtime process env. Never log or
 * stringify the whole result, and never the `env` map. `injected`, `missing`, and
 * `rejected` are NAMES only (no values) and are safe to log for diagnostics.
 */
export interface InjectedCredentialEnv {
  /** Env-var name → secret VALUE. The only value-bearing structure. Do not log. */
  env: Record<string, string>;
  /** NAMES whose secret resolved and was injected into `env`. Safe to log. */
  injected: string[];
  /** NAMES skipped because the secret was absent or empty. Safe to log. */
  missing: string[];
  /** NAMES skipped because they are not valid/safe credential env names. Safe to log. */
  rejected: string[];
}

/**
 * Build the credential env map to inject into a runtime process for an identity's
 * installed bundles. Pure composer over the resolved bundles + an injected
 * {@link SecretProvider}.
 *
 * Behavior (pinned by tests):
 *  - Only env-var names DECLARED by the given bundles are ever considered — nothing
 *    ambient is injected. Names declared by multiple bundles are deduped (first-seen
 *    order across the bundle list).
 *  - A name is REJECTED — never injected, reported in `rejected` — unless it is a
 *    valid credential env name (see {@link isCredentialEnvName}) AND falls under one
 *    of its declaring bundle's `envPrefixes`. The prefix allowlist is the primary
 *    guard that keeps a bundle inside its own credential namespace (a denylist alone
 *    cannot guarantee that); the format check is the baseline.
 *  - A secret that is `undefined` OR empty-string is treated as MISSING: it is
 *    skipped (never injected as `undefined`/empty) and reported in `missing`. The
 *    caller decides whether a missing credential is fatal for a given run.
 *  - A non-empty secret is written to `env` and its name reported in `injected`.
 *
 * Intended merge precedence at the call site: `Object.assign(runtimeEnv, result.env)`
 * — injected credentials WIN over ambient/global env, matching the adapter rule that
 * per-agent runtime env takes precedence. Deferred: wiring this into the worker's
 * `workspace.runtimeEnv` assembly is a follow-up; this is the tested pure seam.
 */
export function buildInjectedCredentialEnv(
  resolvedBundles: AccessBundle[],
  secretProvider: SecretProvider,
): InjectedCredentialEnv {
  const env: Record<string, string> = {};
  const injected: string[] = [];
  const missing: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const bundle of resolvedBundles) {
    for (const name of bundle.credentialEnv) {
      if (seen.has(name)) continue;
      seen.add(name);

      // A name is injectable only when it is a valid credential env name AND is a
      // STRICT prefix-match under one of the declaring bundle's prefixes — its own
      // credential namespace. A strict match (name longer than the prefix) rejects a
      // bare prefix like `JIRA_`; an empty-string prefix never grants. Dedup is
      // first-seen across the resolved bundle list (which `resolveIdentityAccess`
      // builds from well-formed seed bundles), and a rejected name stays fail-closed.
      const inNamespace = bundle.envPrefixes.some(
        (p) => p.length > 0 && name.length > p.length && name.startsWith(p),
      );
      if (!isCredentialEnvName(name) || !inNamespace) {
        rejected.push(name);
        continue;
      }

      const value = secretProvider.getSecret(name);
      // Treat undefined AND empty-string identically as missing: an empty
      // credential is "configured but unusable", so never inject it silently.
      if (value === undefined || value === '') {
        missing.push(name);
        continue;
      }

      env[name] = value;
      injected.push(name);
    }
  }

  return { env, injected, missing, rejected };
}
