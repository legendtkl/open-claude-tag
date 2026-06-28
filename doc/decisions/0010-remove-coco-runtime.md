# 0010. Remove the Coco (TRAE CLI) runtime adapter

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-28 |

## Context

`coco` (the TRAE CLI) was a third, optional `RuntimeAdapter` alongside Claude Code
and Codex. It existed largely to demonstrate that a third runtime "drops in" via
the descriptor-driven registry. In practice it carried real maintenance weight: a
787-line adapter, a login-shell binary resolver (`coco-binary.ts`), a dedicated
self-dev workflow appendix, daemon capability detection, and `'coco'` threaded
through zod enums, TS literal unions, and console UI options across ~25 sites — all
for a runtime that is not part of the project's supported surface.

The descriptor registry and `RemoteRuntimeAdapter` already prove the
"new runtime drops in" property without keeping a live third adapter.

## Decision

Remove all `coco` logic: the adapter, binary resolver, descriptor, both
`self-dev-coco.md` workflow prompts, the worker + daemon registration entries, and
the coco unit tests. Narrow the runtime zod enums and TS literal unions
(`RuntimeBackend`, `RuntimeBackendSchema` in core-types + daemon-protocol, admin-api
`RuntimeSchema`, registry manifest, card-builder, card-action-handler,
remote-dispatch, remote-runtime-adapter, workdir-extractor) and drop the console
runtime option, so `coco` can no longer be created going forward.

**No data migration.** `runtime_backend` columns are plain `varchar` with no CHECK
constraint, and no DB read path zod-parses them. The worker's `resolveTaskRuntime`
treats an unknown stored runtime (now including a legacy `'coco'`) as unregistered
and falls back to `claude_code`, so a legacy session/agent/profile degrades
gracefully instead of crashing. Stale `coco` values may still appear in admin
responses as display-only strings; they execute as `claude_code` and cannot be
re-created.

**Daemon protocol stays rolling-upgrade safe.** The hello/pairing
`CapabilitiesSchema.runtimes` is made tolerant of unknown runtime strings (it
filters to runtimes the server knows) instead of a strict enum, so a not-yet-upgraded
daemon still advertising `coco` does not fail capability validation. The
server-controlled dispatch-frame `runtime` enum is narrowed (the server never sends
`coco`).

## Consequences

- ~1,800 fewer lines; one fewer adapter, binary probe, and workflow appendix to
  maintain; `coco` no longer a valid value at any API/validation boundary.
- Legacy persisted `coco` values are handled by graceful runtime fallback, not a
  migration — accepted as display-only stale config.
- The capabilities advertisement is now forward-compatible: an unknown/newer runtime
  a daemon advertises is filtered rather than rejected.
- Historical console release notes still mention coco (left as accurate changelog).

## Alternatives Considered

- **Keep coco as an optional adapter.** Rejected: ongoing maintenance for an
  unsupported runtime; the registry already demonstrates extensibility.
- **Backfill legacy `coco` rows to `claude_code` via a migration.** Rejected as
  unnecessary: the read path already degrades unknown runtimes safely and the
  columns have no CHECK constraint, so a migration adds risk for no correctness gain
  on a fresh release.
- **Hard-narrow the daemon `CapabilitiesSchema.runtimes` enum.** Rejected: it would
  break the `hello` handshake of a rolling daemon still advertising `coco`; tolerate
  + filter instead.
