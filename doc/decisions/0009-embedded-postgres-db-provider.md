# 0009. DB-provider abstraction with an embedded-Postgres (zero-Docker) provider

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-28 |

## Context

Local bootstrap (`pnpm setup:local`) hard-requires Docker, and only for Postgres
(`tools/setup/local.mjs` runs `docker compose up postgres -d`). The personal
quick-start initiative (`PERSONAL_QUICKSTART_PLAN.md`, Stage A) needs a
zero-Docker path so a single-host personal install can provision Postgres with no
system dependencies, while team/CI keep the Docker path and BYO-Postgres users
keep an external path. The whole repo assumes one default DSN
(`postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag`).

`embedded-postgres` (a real, runtime-downloaded PG binary) is the chosen
mechanism. It is **not** published to the internal default registry, only to
public npm, which complicates dependency resolution in a mixed-registry
workspace.

## Decision

Add a vendor-neutral `@open-tag/launcher` package exposing a small **`DbProvider`**
contract — `ensureRunning(): Promise<{ databaseUrl }>` and `stop()` — with three
providers selected by `OPEN_TAG_DB_MODE` (`embedded` | `docker` | `external`,
default `embedded`):

- **Pure selection, thin IO edges.** `resolveDbMode(env)` and
  `resolveDbProvider(mode, env)` are pure and unit-tested; `resolveDbMode` fails
  **closed** on an unrecognized value rather than silently defaulting. Config
  resolution (`resolveEmbeddedConfig` / `resolveDockerConfig` / `buildDatabaseUrl`)
  is pure. IO lives in the providers.
- **`embedded` provider** wraps `embedded-postgres`, **lazy-imported** only when it
  actually boots so docker/external users never load the heavy binary wrapper. It
  `initdb`s a superuser `open-claude-tag` into `~/.open-claude-tag/pgdata`
  (overridable via `OPEN_TAG_PG_DATA_DIR`), starts on `127.0.0.1:5432`
  (overridable via `OPEN_TAG_PG_PORT`), creates the `open-claude-tag` database
  through the `postgres` maintenance DB, healthchecks, and returns the matching
  DSN. It is **idempotent**: it reuses an already-running compatible cluster, only
  swallows a port-in-use error when a probe confirms **our** Postgres is
  answering (otherwise it fails loud), and `stop()` only stops a child **it**
  started — never a foreign server.
- **`docker` provider** mirrors `tools/setup/local.mjs` (`docker compose up
  postgres -d` + `pg_isready` poll) behind an injected command runner. `stop()`
  is a deliberate no-op because the compose Postgres may be shared.
- **`external` provider** owns no lifecycle: it probes `DATABASE_URL` with a
  `select 1` and returns it; `stop()` is a no-op.

**Mixed-registry mechanics (the tricky part).** The internal registry lacks
`embedded-postgres`, so:

- A committed project `.npmrc` pins the scoped binary subpackages to public npm:
  `@embedded-postgres:registry=https://registry.npmjs.org/`.
- The **unscoped** `embedded-postgres` cannot be scope-pinned, and a pnpm v9
  lockfile records integrity only (no per-package registry), so on a machine
  whose default registry lacks the package a bare-version dependency would resolve
  against that default and fail. We therefore depend on it via an **explicit
  public-npm tarball URL** in `packages/launcher/package.json`
  (`https://registry.npmjs.org/embedded-postgres/-/embedded-postgres-16.14.0-beta.17.tgz`),
  a committed, registry-independent source. `pnpm install --frozen-lockfile`
  (and `--offline`) was verified green and non-destabilizing for the rest of the
  workspace.

## Consequences

- A reusable, vendor-neutral DB-provider seam that the later launcher CLI / doctor
  slices (`up`, `down`, readiness) build on without re-deciding lifecycle.
- A proven zero-Docker Postgres path: the feasibility check boots a real embedded
  cluster, applies all migrations, serves a query, and shuts down clean.
- Internal contributors must keep `embedded-postgres` reachable from public npm
  (the `.npmrc` scope pin + committed tarball URL). If an internal registry ever
  mirrors it, the tarball URL can be relaxed to a bare version.
- This slice adds the capability only; it is not yet wired into `setup:local`,
  `doctor:local`, or a launcher `bin` (later slices A3/A4).

## Alternatives Considered

- **Bare-version `embedded-postgres` dependency.** Rejected as the committed
  source: resolves against whatever default registry a machine has, which for the
  internal default lacks the package.
- **`optionalDependency` for `embedded-postgres`.** Rejected as the primary
  approach: it improves install resilience but weakens the feature contract and
  could let CI pass with the embedded path unusable. The explicit tarball URL
  keeps it a hard, provable dependency.
- **Prove the embedded boot on the default `5432`.** Rejected for the automated
  check: `5432` is held by the repo's docker-compose Postgres (needed by the
  integration gate), so the proof uses an isolated free port + temp data dir and
  asserts `OPEN_TAG_PG_PORT` overrides the `5432` default.
- **Fold lifecycle into `tools/setup`.** Rejected: a typed, injectable provider
  contract is unit-testable and reusable across the CLI/doctor slices, unlike an
  inline script.
