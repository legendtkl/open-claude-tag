export interface SlashCommandMetadata {
  ownerOnly?: boolean;
  taskCommand?: boolean;
  internal?: boolean;
}

export const SLASH_COMMAND_METADATA = {
  '/new': {},
  '/reset': {},
  '/status': {},
  // /session worktrees|clean are owner-only at subcommand level inside the
  // handler; the command itself stays open for list|use.
  '/session': {},
  '/compact': {},
  '/forget': {},
  '/chat': { ownerOnly: true },
  '/agent': {},
  '/project': { ownerOnly: true },
  '/schedule': { ownerOnly: true },
  '/add-bot': { ownerOnly: true },
  '/clean-task': { ownerOnly: true },
  '/configure-tasklist': { internal: true },
  '/help': {},
  '/merge-pr': { ownerOnly: true },
  '/close': {},
} as const satisfies Record<string, SlashCommandMetadata>;

export type SlashCommand = keyof typeof SLASH_COMMAND_METADATA;

export const SLASH_COMMANDS = Object.keys(SLASH_COMMAND_METADATA) as SlashCommand[];

export function isSlashCommand(value: string): value is SlashCommand {
  return Object.hasOwn(SLASH_COMMAND_METADATA, value);
}

export function isOwnerOnlySlashCommand(command: string): boolean {
  if (!isSlashCommand(command)) return false;
  const metadata = SLASH_COMMAND_METADATA[command] as SlashCommandMetadata;
  return Boolean(metadata.ownerOnly);
}

export function isTaskSlashCommand(command: string): boolean {
  if (!isSlashCommand(command)) return false;
  const metadata = SLASH_COMMAND_METADATA[command] as SlashCommandMetadata;
  return Boolean(metadata.taskCommand);
}
