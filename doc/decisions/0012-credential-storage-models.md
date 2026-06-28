# 0012. Credential storage models: runtimeEnv (stored, masked) vs access-bundle (never stored)

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-29 |

## Context

OpenClaudeTag has two ways for an agent run to receive credential-like environment
variables, and their security semantics differ. This was raised as a P2 (issue
\#18): the README's access-bundle line ("values come from a secret provider, never
stored") reads as a blanket guarantee, while the per-agent `runtimeEnv` path can in
fact write a raw API key into Postgres. The two paths needed to be named and their
guarantees written down so the storage model is auditable and not surprising.

The relevant code today:

- **runtimeEnv** — the admin API accepts `runtimeEnv: Record<envName, string>` on
  agent create/update (`RuntimeEnvSchema` in `apps/api/src/admin-api.ts`). The
  Claude custom-credential validator deliberately accepts the pair
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` so an agent can run against a custom
  Claude gateway. Values are persisted verbatim into `agents.runtime_env`
  (`jsonb`, `packages/storage/src/schema.ts`).
- **access-bundle** — `buildInjectedCredentialEnv`
  (`packages/registry/src/access-injection.ts`) stores only env-var NAMES on a
  bundle; the VALUES are resolved from an injected `SecretProvider` at execution
  time and merged into the runtime process env. Names that are not in a bundle's
  declared namespace, or that are process-hijack vectors, are rejected. Nothing
  value-bearing is persisted.

Two facts are already true and must not regress:

1. The API never returns secret VALUES. `AgentDto` exposes only `runtimeEnvKeys`
   (key names), and that masking is covered by existing tests.
2. The access-bundle path never persists VALUES.

So this is a credential-storage-model clarity gap plus an optional hardening
opportunity, not an exploitable data leak.

## Decision

Recognize and document two distinct credential storage models, and add a
non-blocking guard rail; do **not** change the persistence shape now.

1. **runtimeEnv (literal, stored)** — per-agent literal env, stored as plaintext in
   `agents.runtime_env` and masked to key names in API responses
   (`runtimeEnvKeys`). Acceptable for non-sensitive config and for per-agent custom
   Claude credentials (`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`), which remain a
   supported feature.

2. **access-bundle (names only, resolved at execution)** — bundles declare env
   NAMES; VALUES are resolved from a `SecretProvider` at execution time and are
   never persisted. This is the path the README's "never stored" guarantee refers
   to, and it stays that way.

3. **Sensitive-key WARN, not reject.** On agent create (`POST /admin/agents`) and
   update (`PATCH /admin/agents/:id`), when the written `runtimeEnv` contains keys
   matching `/(^|_)(API_KEY|TOKEN|SECRET)$/i` (or `ANTHROPIC_API_KEY` explicitly),
   emit one structured WARN by key NAME only
   (`event: 'runtimeEnv.sensitive_key_stored'`). It must **warn, not reject** —
   rejecting would break the existing, tested per-agent `ANTHROPIC_API_KEY`
   feature — and it must **never log the VALUE**.

4. **README scoping.** Scope the "never stored" guarantee to the access-bundle path
   and add a one-line caveat that `runtimeEnv` values ARE stored (masked in API
   responses).

### Deferred (future work, not implemented here)

A **secretRef** model where `runtimeEnv` entries become discriminated unions:

```ts
runtimeEnv: {
  ANTHROPIC_BASE_URL: { type: 'literal', value: 'https://...' },
  ANTHROPIC_API_KEY:  { type: 'secretRef', ref: 'env:USER_ANTHROPIC_API_KEY' },
}
```

with a migration that detects existing secret-looking literals and guides
reconfiguration, and eventually disallows raw secret literals. This should be
designed alongside the remote-daemon credential-forwarding boundary and
access-bundle remote injection (so secret resolution stays server-side and a daemon
never receives raw secrets), not bolted on ahead of them. It is intentionally NOT
built now.

## Consequences

- The two storage models are named and their guarantees are written down; the
  README no longer over-promises.
- Operators get a by-name warning when they persist a secret-looking literal,
  pointing them at access-bundles — without breaking the existing custom-Claude-credential
  flow.
- No schema, persistence, or API-shape change; existing masking and
  `ANTHROPIC_*` behavior are unchanged.
- The stronger guarantee (no raw secret literals in the DB) is deferred to the
  secretRef model, to be designed with the remote-daemon forwarding boundary.

## Alternatives Considered

- **Reject sensitive runtimeEnv keys outright.** Rejected: it would break the
  supported per-agent `ANTHROPIC_API_KEY` custom-credential feature and any existing
  agents relying on it. A warning conveys the same guidance without a breaking
  change.
- **Build the secretRef model now.** Rejected as premature: it is entangled with the
  remote-daemon credential boundary and access-bundle remote injection, which are not
  yet in place. Designing it in isolation risks a shape that does not fit the remote
  path. Deferred above.
- **Do nothing (docs only).** Rejected: the cheap, non-breaking WARN materially
  improves the auditability of plaintext secret storage at write time, which is the
  decisive low-risk part of the issue.
