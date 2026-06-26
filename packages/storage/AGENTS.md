# storage — Agent Guide

## MUST

- Use Drizzle ORM for all database operations
- Credentials come from env vars — never hardcode in source

## Key Concepts

- Drizzle ORM schemas define all tables
- Migrations are managed via Drizzle Kit
- Default local DB: `postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag` (from `.env`)
- `sessions.prLastPolledAt` — nullable timestamp, added in migration `0004`
- `tasks.feedbackMessageId` — stores Feishu message ID for card updates
- `tasks.feedbackCardType`, `tasks.feedbackState`, `tasks.feedbackUpdatedAt` — card metadata
- `tasks.parentTaskId` — links retry/follow-up tasks to original
