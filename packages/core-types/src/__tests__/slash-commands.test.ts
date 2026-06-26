import { describe, expect, it } from 'vitest';
import {
  SLASH_COMMAND_METADATA,
  SLASH_COMMANDS,
  isOwnerOnlySlashCommand,
  isSlashCommand,
  isTaskSlashCommand,
} from '../slash-commands.js';

describe('slash command metadata', () => {
  it('recognizes every registered slash command', () => {
    for (const command of SLASH_COMMANDS) {
      expect(isSlashCommand(command)).toBe(true);
    }
  });

  it('keeps owner-only commands inside the shared registry', () => {
    expect(isOwnerOnlySlashCommand('/merge-pr')).toBe(true);
    expect(isOwnerOnlySlashCommand('/add-bot')).toBe(true);
    expect(isOwnerOnlySlashCommand('/clean-task')).toBe(true);
    expect(isOwnerOnlySlashCommand('/chat')).toBe(true);
    expect(isOwnerOnlySlashCommand('/project')).toBe(true);
    expect(isOwnerOnlySlashCommand('/schedule')).toBe(true);
  });

  it('does not classify regular slash commands as task commands', () => {
    expect(isTaskSlashCommand('/status')).toBe(false);
    expect(isTaskSlashCommand('/agent')).toBe(false);
    expect(isOwnerOnlySlashCommand('/agent')).toBe(false);
    expect(isTaskSlashCommand('/merge-pr')).toBe(false);
    expect(isTaskSlashCommand('/clean-task')).toBe(false);
  });

  it('no longer registers the removed /machine command (D-A7: console-only machines)', () => {
    expect(isSlashCommand('/machine')).toBe(false);
    expect(SLASH_COMMANDS).not.toContain('/machine');
  });

  it('no longer registers the commands removed by slim-slash-commands', () => {
    for (const removed of ['/use', '/approve', '/reject', '/init', '/sessions', '/ping']) {
      expect(isSlashCommand(removed)).toBe(false);
      expect(SLASH_COMMANDS).not.toContain(removed);
      expect(isOwnerOnlySlashCommand(removed)).toBe(false);
      expect(isTaskSlashCommand(removed)).toBe(false);
    }
  });

  it('keeps /session open to all users (worktree subcommands gate inside the handler)', () => {
    expect(isSlashCommand('/session')).toBe(true);
    expect(isOwnerOnlySlashCommand('/session')).toBe(false);
    expect(isTaskSlashCommand('/session')).toBe(false);
  });

  it('recognizes /close as a non-task slash command', () => {
    expect(isSlashCommand('/close')).toBe(true);
    expect(isTaskSlashCommand('/close')).toBe(false);
    expect(isOwnerOnlySlashCommand('/close')).toBe(false);
  });

  it('recognizes /configure-tasklist as an internal non-owner command', () => {
    expect(isSlashCommand('/configure-tasklist')).toBe(true);
    expect(isTaskSlashCommand('/configure-tasklist')).toBe(false);
    expect(isOwnerOnlySlashCommand('/configure-tasklist')).toBe(false);
    expect(SLASH_COMMAND_METADATA['/configure-tasklist'].internal).toBe(true);
  });

  it('rejects unknown commands', () => {
    expect(isSlashCommand('/unknown')).toBe(false);
    expect(isOwnerOnlySlashCommand('/unknown')).toBe(false);
    expect(isTaskSlashCommand('/unknown')).toBe(false);
  });
});
