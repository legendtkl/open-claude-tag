export type LauncherCommand = 'up' | 'down' | 'status' | 'db-host' | 'help';

export interface ParsedArgs {
  command: LauncherCommand;
  /** Force `pnpm build` before starting services. */
  build: boolean;
  /** Skip the build step even if dist artifacts look missing. */
  noBuild: boolean;
  /** Do not open a browser at the end of `up`. */
  noOpen: boolean;
  unknown: string[];
}

const COMMANDS: ReadonlySet<string> = new Set(['up', 'down', 'status', 'db-host', 'help']);

/**
 * Tiny hand-rolled parser — no dependency. The first non-flag token is the
 * command (default `help`); recognized flags toggle booleans; anything else is
 * collected in `unknown` so the caller can fail fast on typos.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: LauncherCommand = 'help';
  let commandSeen = false;
  const result: Omit<ParsedArgs, 'command'> = {
    build: false,
    noBuild: false,
    noOpen: false,
    unknown: [],
  };

  for (const token of argv) {
    if (!commandSeen && COMMANDS.has(token)) {
      command = token as LauncherCommand;
      commandSeen = true;
      continue;
    }
    switch (token) {
      case '--build':
        result.build = true;
        break;
      case '--no-build':
        result.noBuild = true;
        break;
      case '--no-open':
        result.noOpen = true;
        break;
      case '-h':
      case '--help':
        command = 'help';
        commandSeen = true;
        break;
      default:
        result.unknown.push(token);
    }
  }

  return { command, ...result };
}

export const USAGE = `open-claude-tag — one-command personal stack

Usage:
  open-claude-tag up [--build] [--no-build] [--no-open]
  open-claude-tag down
  open-claude-tag status

Commands:
  up      Provision the database, run migrations + seed, start API + Worker +
          Console, wait for /health, and open the console in your browser.
  down    Stop the Console, Worker, API, and (embedded) the database.
  status  Report the DB mode, database, services, and /health.

Environment:
  OPEN_TAG_DB_MODE        embedded (default) | docker | external
  OPEN_TAG_API_PORT       API port (default 3000)
  OPEN_TAG_CONSOLE_PORT   Console port (default 8080)
  OPEN_TAG_PG_PORT        Embedded Postgres port (default 5432)
  OPEN_TAG_PG_DATA_DIR    Embedded Postgres data dir (default ~/.open-claude-tag/pgdata)
  OPEN_TAG_FEISHU_ACCESS  enabled to open a live Feishu websocket (default disabled)
`;
