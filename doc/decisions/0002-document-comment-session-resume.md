# 0002. Document Comment Session Resume

| Field  | Value      |
| ------ | ---------- |
| Status | Accepted   |
| Date   | 2026-06-25 |

## Context

Feishu document comment follow-ups can arrive as separate comment replies even
when a user is continuing the same request to the same bot. The first
document-comment implementation keyed synthetic sessions by reply ID, so a
second mention under the same comment ID started a fresh runtime conversation.
That lost the runtime session history already persisted by the Worker.

## Decision

Use the Feishu document comment thread as the host-session boundary for a given
receiving bot or routed agent: tenant, file token, comment ID, and bot or agent
identity define continuity. The current reply ID remains event and delivery
metadata, but it does not decide whether to start a new host session.

Runtime resume is the primary context inheritance mechanism. Bounded Feishu
comment-thread history remains useful supplementary context, especially when no
SDK session exists or a runtime cannot resume.

## Consequences

- Same-bot follow-ups in one document comment thread can resume the existing
  runtime conversation, matching Feishu topic behavior more closely.
- Different bots or agents remain isolated even when users mention them in the
  same comment thread.
- Existing reply-scoped sessions are not migrated; the new boundary applies to
  newly processed events.
- Comment history rendering still needs bounding so large Feishu threads do not
  overinflate task goals or queued constraints.

## Alternatives Considered

- **Inject all prior Feishu comment replies into every follow-up and keep
  reply-scoped sessions.** Rejected because it reconstructs context manually and
  still prevents runtimes from using their native resume state.
- **Key only by tenant, file token, and comment ID.** Rejected because multiple
  bots can participate in the same comment thread and must not share runtime
  state.
- **Migrate existing reply-scoped document-comment sessions.** Rejected for this
  change because there is no schema issue to repair and safe matching across
  historical bot bindings would add unnecessary operational risk.
