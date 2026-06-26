# core-types — Agent Guide

## MUST

- Register ALL slash commands in `src/slash-commands.ts` — this is the single source of truth
- Commands with hyphens (e.g., `/merge-pr`) must be covered by the registry and tested in normalizer

## Key Files

- `src/slash-commands.ts` — Centralized slash command definitions (name, owner-only, description)
- Used by `feishu-adapter/normalizer.ts` for recognition and `apps/api/server.ts` for routing
