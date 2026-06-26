/**
 * Unit tests for slash command help texts.
 *
 * Verifies that each --help entry is non-empty, contains the command name,
 * a Usage line, and the expected sub-commands or key terms.
 */
import { describe, it, expect } from 'vitest';
import { SLASH_COMMAND_METADATA, SLASH_COMMANDS } from '@open-tag/core-types';
import { HELP_TEXTS, HELP_TEXTS_ZH, getHelpText } from '../slash-command-help.js';

describe('HELP_TEXTS', () => {
  it('every command entry is a non-empty string', () => {
    for (const [cmd, text] of Object.entries(HELP_TEXTS)) {
      expect(text.length, `${cmd} help should not be empty`).toBeGreaterThan(0);
    }
  });

  describe('/session --help', () => {
    const text = HELP_TEXTS['/session'];

    it('contains command name', () => {
      expect(text).toContain('/session');
    });

    it('lists "list" sub-command', () => {
      expect(text).toContain('list');
    });

    it('lists "use <id>" sub-command', () => {
      expect(text).toContain('use <id>');
    });

    it('lists owner-only worktree sub-commands', () => {
      expect(text).toContain('worktrees');
      expect(text).toContain('clean');
      expect(text).toContain('clean <id>');
      expect(text).toContain('Owner only');
    });
  });

  describe('/schedule --help', () => {
    const text = HELP_TEXTS['/schedule'];

    it('contains command name', () => {
      expect(text).toContain('/schedule');
    });

    it('lists supported time formats', () => {
      expect(text).toContain('分钟后');
      expect(text).toContain('小时后');
      expect(text).toContain('明天');
      expect(text).toContain('ISO-8601');
    });

    it('includes examples', () => {
      expect(text).toContain('Examples:');
    });
  });

  describe('/help listing', () => {
    const text = HELP_TEXTS['/help'];

    it('includes every user-facing registered command', () => {
      const userFacingCommands = SLASH_COMMANDS.filter((cmd) => {
        const metadata = SLASH_COMMAND_METADATA[cmd] as { internal?: boolean };
        return !metadata.internal;
      });

      for (const cmd of userFacingCommands) {
        expect(text, `English /help should include ${cmd}`).toContain(cmd);
        expect(HELP_TEXTS_ZH['/help'], `Chinese /help should include ${cmd}`).toContain(cmd);
      }
    });

    it('does not list internal commands', () => {
      expect(text).not.toContain('/configure-tasklist');
      expect(HELP_TEXTS_ZH['/help']).not.toContain('/configure-tasklist');
    });

    it('includes all public commands', () => {
      expect(text).toContain('/new');
      expect(text).toContain('/reset');
      expect(text).toContain('/status');
      expect(text).toContain('/session');
      expect(text).toContain('/close');
      expect(text).toContain('/compact');
      expect(text).toContain('/forget');
    });

    it('includes owner-only commands', () => {
      expect(text).toContain('/schedule');
      expect(text).toContain('/add-bot');
      expect(text).toContain('/clean-task');
      expect(text).toContain('/project');
      expect(text).toContain('/merge-pr');
      expect(text).toContain('/session worktrees');
      expect(text).toContain('/session clean');
    });

    it('no longer lists the commands removed by slim-slash-commands', () => {
      for (const helpText of [text, HELP_TEXTS_ZH['/help']]) {
        expect(helpText).not.toContain('/approve');
        expect(helpText).not.toContain('/reject');
        expect(helpText).not.toContain('/use ');
        expect(helpText).not.toContain('/init');
        expect(helpText).not.toContain('/sessions');
        expect(helpText).not.toContain('set-runtime');
        expect(helpText).not.toContain('/ping');
      }
    });

    it('mentions --help tip', () => {
      expect(text).toContain('--help');
    });
  });

  describe('/project --help', () => {
    const text = HELP_TEXTS['/project'];

    it('lists all sub-commands', () => {
      expect(text).toContain('list');
      expect(text).toContain('add');
      expect(text).toContain('remove');
      expect(text).toContain('use');
      expect(text).toContain('clear');
    });
  });

  describe('/merge-pr --help', () => {
    const text = HELP_TEXTS['/merge-pr'];

    it('contains command name', () => {
      expect(text).toContain('/merge-pr');
    });

    it('notes owner-only restriction', () => {
      expect(text).toContain('owner');
    });

    it('describes squash merge and branch deletion', () => {
      expect(text).toContain('Squash');
      expect(text).toContain('branch');
    });
  });

  describe('removed commands have no help entries', () => {
    it.each(['/sessions', '/init', '/use', '/approve', '/reject', '/ping'])(
      '%s help block is gone',
      (cmd) => {
        expect(HELP_TEXTS[cmd]).toBeUndefined();
        expect(HELP_TEXTS_ZH[cmd]).toBeUndefined();
      },
    );
  });

  describe('/add-bot --help', () => {
    const text = HELP_TEXTS['/add-bot'];

    it('contains command name', () => {
      expect(text).toContain('/add-bot');
    });

    it('describes shared task board configuration', () => {
      expect(text).toContain('task board');
      expect(text).toContain('configuration');
    });
  });

  describe('/machine removed (D-A7: console-only machines)', () => {
    it('no longer exposes a /machine help block', () => {
      expect(HELP_TEXTS['/machine']).toBeUndefined();
      expect(HELP_TEXTS_ZH['/machine']).toBeUndefined();
    });

    it('directs users to the admin console for machine management', () => {
      expect(HELP_TEXTS['/help']).toContain('admin console');
      expect(HELP_TEXTS_ZH['/help']).toContain('管理控制台');
    });
  });

  describe('/clean-task --help', () => {
    const text = HELP_TEXTS['/clean-task'];

    it('contains command name', () => {
      expect(text).toContain('/clean-task');
    });

    it('documents cleanup scope and retention controls', () => {
      expect(text).toContain('--chat');
      expect(text).toContain('--dry-run');
      expect(text).toContain('--days');
      expect(text).toContain('retention');
    });
  });
});

describe('getHelpText', () => {
  it('returns Chinese help text when reply language is zh-CN', () => {
    const text = getHelpText('/status', 'zh-CN');

    expect(text).toContain('/status');
    expect(text).toContain('用法');
  });

  it('falls back to English help text for unsupported commands', () => {
    expect(getHelpText('/unknown', 'zh-CN')).toBe('');
    expect(getHelpText('/status', 'en-US')).toBe(HELP_TEXTS['/status']);
  });
});
