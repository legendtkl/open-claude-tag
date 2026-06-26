# 0003. Chat Memory Index And Detail Store

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-06-24 |

## Context

Feishu group chats need durable context that survives topic boundaries, but
OpenClaudeTag already has separate concepts for topic/session summaries and
agent-owned long-term memory. The new chat-level memory must not leak between
chats, must not become an unbounded prompt dump, and must be safe to update from
scheduled agent work.

## Decision

Store chat memory as database-owned records scoped by `(tenant_key, chat_id)`.
Each chat keeps a small `index` entry plus bounded `detail` entries with
keywords and importance. Context injection always treats this data as
untrusted background and injects only a compact `<chat_memory>` section: the
index plus relevant detail hints selected for the current request.

Daily summarization is implemented as a normal queued agent task resolved from
the chat's agent configuration. The agent produces a structured memory-update
block; the worker commits that block to chat memory only after successful task
completion.

## Consequences

- Chat memory stays independent from agent memory and session summaries.
- Fresh topics can receive useful group context without merging all group
  traffic into one session.
- Scheduled summarization reuses the existing task queue, runtime selection,
  cards, and audit trail.
- Memory quality depends on the resolved chat agent and the structured update
  block; invalid updates are rejected while preserving existing memory.

## Alternatives Considered

- Reuse `memory_entries` with `scope_type = group`: rejected because it is a
  flat fact store and does not encode the index/detail progressive-disclosure
  contract or scheduled summary state.
- Store chat memory in files like agent memory: rejected because chat memory is
  shared across agents and execution machines, so DB ownership and inspection
  fit the existing group/chat control plane better.
- Inject full group summaries on every topic: rejected because it would grow
  prompt cost and violates the progressive-disclosure requirement.
