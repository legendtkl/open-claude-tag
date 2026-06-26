# Slash Command Verification Matrix

This document is the detailed verification reference for slash command behavior. `AGENTS.md` keeps only the high-level testing summary and points here for the full matrix.

## Scope

The matrix covers:

- Command recognition and help paths
- Owner-only permission boundaries (command-level and subcommand-level)
- Scheduling and session management flows
- Thread-aware reply behavior where applicable

## Core Matrix

| Command | Primary coverage | Key assertions |
| --- | --- | --- |
| `/help` | Help entry point | Command is recognized and returns the command index |
| `/status` | Public command + health check | Any user can access current session info; reply ends with process uptime and RSS, also shown when no session exists yet |
| `/new` | Group manual session routing | Creates a fresh manual group session and replies without an unknown-command error |
| `/reset` | Group manual session routing | Clears the manual-session pointer and returns to the group main session |
| `/session` | Public command + owner subcommands | `list` and `use` routes work for all users; `worktrees` and `clean` are owner-only at subcommand level (OPEN_ACCESS bypass honored); help text is available |
| `/close` | Public command | Archives the current session and removes its managed worktree when present |
| `/compact` | Public command | Session compaction executes and reports token reduction |
| `/forget` | Public command | Matching memory entries are deleted and counted |
| `/schedule <time> <goal>` | Deferred self-dev | Parsed goal is enqueued with delayed start and session runtime continuity |
| `/project ...` | Owner-only project registry | CRUD and binding flows are available through slash routing |
| `/chat init` | Owner-only chat config + task board setup | Initializes chat config and binds the chat task board |
| `/add-bot @bot` | Owner-only task board sharing | Shares the current chat task board with another bot |
| `/merge-pr` | Owner-only merge | Session PR/MR URL is required and merged worktree cleanup follows |
| Removed commands | `/sessions`, `/use`, `/approve`, `/reject`, `/init`, `/ping` | Not recognized as commands; the text degrades to normal message handling |
| `/configure-tasklist` | Internal bot-to-bot configuration | Registered for bot-sent payloads but omitted from user-facing `/help` |

## Permission Coverage

For every owner-only command, verify both paths:

1. Owner request is accepted and reaches the expected command/task flow.
2. Non-owner request is accepted at the transport layer but rejected internally with no privileged side effect.

Owner-only commands currently include (registry `ownerOnly` flags):

- `/schedule`
- `/project`
- `/chat`
- `/add-bot`
- `/clean-task`
- `/merge-pr`

Subcommand-level owner checks (command itself stays public):

- `/session worktrees`
- `/session clean [...]`

## Threading Coverage

Thread-aware slash command tests should confirm:

- Commands sent in a topic thread reply in the same thread
- Root-level P2P commands create a topic thread under the user's message
- Root-level group commands create a topic thread under the user's message
- Follow-up messages in a command-created topic resolve to the same session
- Help replies in a thread remain threaded
- Permission-denied replies in a thread remain threaded
## Test Layers

- Unit: command help text, argument parsing, queue payload construction
- Integration: slash command handler behavior
- E2E: `POST /debug/simulate` covering owner-only commands, subcommand-level permission paths, and health checks
