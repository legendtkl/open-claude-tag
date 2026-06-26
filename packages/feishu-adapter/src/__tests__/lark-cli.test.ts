import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { LarkCli } from '../lark-cli.js';

// Mock child_process.spawn
vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
  };
});

import { spawn } from 'node:child_process';

function mockSpawn(
  stdout: string,
  stderr: string,
  exitCode: number,
  opts?: { delay?: number; error?: Error },
) {
  const stdoutHandlers: Array<(data: Buffer) => void> = [];
  const stderrHandlers: Array<(data: Buffer) => void> = [];
  const closeHandlers: Array<(code: number | null) => void> = [];
  const errorHandlers: Array<(err: Error) => void> = [];

  const proc = {
    stdout: {
      on: vi.fn((event: string, handler: (data: Buffer) => void) => {
        if (event === 'data') stdoutHandlers.push(handler);
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (data: Buffer) => void) => {
        if (event === 'data') stderrHandlers.push(handler);
      }),
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') closeHandlers.push(handler as (code: number | null) => void);
      if (event === 'error') errorHandlers.push(handler as (err: Error) => void);
    }),
    kill: vi.fn(),
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  (spawn as unknown as Mock).mockReturnValue(proc);

  // Emit data and close after a tick
  setTimeout(() => {
    if (opts?.error) {
      for (const h of errorHandlers) h(opts.error);
      return;
    }
    for (const h of stdoutHandlers) h(Buffer.from(stdout));
    for (const h of stderrHandlers) h(Buffer.from(stderr));
    setTimeout(() => {
      for (const h of closeHandlers) h(exitCode);
    }, opts?.delay ?? 0);
  }, 0);

  return proc;
}

describe('LarkCli', () => {
  let cli: LarkCli;

  beforeEach(() => {
    vi.clearAllMocks();
    cli = new LarkCli({ binaryPath: '/usr/bin/lark-cli', timeoutMs: 5000 });
  });

  describe('exec', () => {
    it('returns parsed JSON data on success', async () => {
      const jsonOut = JSON.stringify({ ok: true, data: { message_id: 'om_123' } });
      mockSpawn(jsonOut, '', 0);

      const result = await cli.exec(['im', '+messages-send', '--text', 'hi']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(jsonOut);
      expect(result.data).toEqual({ ok: true, data: { message_id: 'om_123' } });
      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/lark-cli',
        ['im', '+messages-send', '--text', 'hi'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
    });

    it('returns non-zero exit code without throwing', async () => {
      const errorOut = JSON.stringify({ ok: false, error: { message: 'unauthorized' } });
      mockSpawn(errorOut, 'some warning', 1);

      const result = await cli.exec(['doctor']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('some warning');
      expect(result.data).toEqual({ ok: false, error: { message: 'unauthorized' } });
    });

    it('leaves data undefined when stdout is not JSON', async () => {
      mockSpawn('lark-cli version 1.0.0', '', 0);

      const result = await cli.exec(['--version']);

      expect(result.exitCode).toBe(0);
      expect(result.data).toBeUndefined();
      expect(result.stdout).toBe('lark-cli version 1.0.0');
    });

    it('rejects on spawn error (binary not found)', async () => {
      mockSpawn('', '', 0, { error: new Error('spawn ENOENT') });

      await expect(cli.exec(['--version'])).rejects.toThrow('spawn ENOENT');
    });
  });

  describe('isAvailable', () => {
    it('returns true when binary exists', async () => {
      mockSpawn('lark-cli version 1.0.0', '', 0);

      const available = await cli.isAvailable();
      expect(available).toBe(true);
    });

    it('returns false when binary not found', async () => {
      mockSpawn('', '', 0, { error: new Error('spawn ENOENT') });

      const available = await cli.isAvailable();
      expect(available).toBe(false);
    });

    it('returns false when exit code is non-zero', async () => {
      mockSpawn('', 'error', 127);

      const available = await cli.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe('doctor', () => {
    it('runs lark-cli doctor', async () => {
      const doctorOutput = JSON.stringify({ ok: true, checks: [] });
      mockSpawn(doctorOutput, '', 0);

      const result = await cli.doctor();

      expect(result.data).toEqual({ ok: true, checks: [] });
      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/lark-cli',
        ['doctor'],
        expect.any(Object),
      );
    });
  });

  describe('convenience methods', () => {
    it('sendText constructs correct arguments', async () => {
      mockSpawn('{}', '', 0);

      await cli.sendText('oc_123', 'hello world');

      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/lark-cli',
        ['im', '+messages-send', '--chat-id', 'oc_123', '--text', 'hello world'],
        expect.any(Object),
      );
    });

    it('sendMarkdown constructs correct arguments', async () => {
      mockSpawn('{}', '', 0);

      await cli.sendMarkdown('oc_123', '**bold** text');

      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/lark-cli',
        ['im', '+messages-send', '--chat-id', 'oc_123', '--markdown', '**bold** text'],
        expect.any(Object),
      );
    });

    it('sendCard constructs correct arguments with JSON content', async () => {
      mockSpawn('{}', '', 0);
      const card = { header: { title: 'Test' }, elements: [] };

      await cli.sendCard('oc_123', card);

      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/lark-cli',
        [
          'im', '+messages-send',
          '--chat-id', 'oc_123',
          '--msg-type', 'interactive',
          '--content', JSON.stringify(card),
        ],
        expect.any(Object),
      );
    });

    it('updateCard constructs correct PATCH arguments', async () => {
      mockSpawn('{}', '', 0);
      const card = { schema: '2.0', header: { title: 'Done' } };

      await cli.updateCard('om_abc', card);

      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/lark-cli',
        [
          'api', 'PATCH', '/open-apis/im/v1/messages/om_abc',
          '--data', JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) }),
        ],
        expect.any(Object),
      );
    });

    it('searchChat constructs correct arguments', async () => {
      mockSpawn('{}', '', 0);

      await cli.searchChat('dev team');

      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/lark-cli',
        ['im', '+chat-search', '--query', 'dev team'],
        expect.any(Object),
      );
    });

    it('listMessages constructs correct arguments with default page size', async () => {
      mockSpawn('{}', '', 0);

      await cli.listMessages('oc_456');

      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/lark-cli',
        ['im', '+chat-messages-list', '--chat-id', 'oc_456', '--page-size', '10'],
        expect.any(Object),
      );
    });

    it('listMessages accepts custom page size', async () => {
      mockSpawn('{}', '', 0);

      await cli.listMessages('oc_456', 25);

      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/lark-cli',
        ['im', '+chat-messages-list', '--chat-id', 'oc_456', '--page-size', '25'],
        expect.any(Object),
      );
    });
  });

  describe('timeout', () => {
    it('kills process and rejects on timeout', async () => {
      // Use a very short timeout
      const shortCli = new LarkCli({ binaryPath: '/usr/bin/lark-cli', timeoutMs: 10 });

      const stdoutHandlers: Array<(data: Buffer) => void> = [];
      const stderrHandlers: Array<(data: Buffer) => void> = [];
      const closeHandlers: Array<(code: number | null) => void> = [];
      const errorHandlers: Array<(err: Error) => void> = [];

      const proc = {
        stdout: {
          on: vi.fn((_event: string, handler: (data: Buffer) => void) => {
            stdoutHandlers.push(handler);
          }),
        },
        stderr: {
          on: vi.fn((_event: string, handler: (data: Buffer) => void) => {
            stderrHandlers.push(handler);
          }),
        },
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'close') closeHandlers.push(handler as (code: number | null) => void);
          if (event === 'error') errorHandlers.push(handler as (err: Error) => void);
        }),
        kill: vi.fn(),
        stdio: ['pipe', 'pipe', 'pipe'],
      };

      (spawn as unknown as Mock).mockReturnValue(proc);

      // Never emit close — let the timeout fire
      await expect(shortCli.exec(['doctor'])).rejects.toThrow('lark-cli timed out after 10ms');
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('options', () => {
    it('uses LARK_CLI_PATH env var when no binaryPath provided', async () => {
      const origEnv = process.env.LARK_CLI_PATH;
      process.env.LARK_CLI_PATH = '/custom/path/lark-cli';
      try {
        const customCli = new LarkCli();
        mockSpawn('ok', '', 0);
        await customCli.exec(['--version']);
        expect(spawn).toHaveBeenCalledWith(
          '/custom/path/lark-cli',
          ['--version'],
          expect.any(Object),
        );
      } finally {
        if (origEnv === undefined) {
          delete process.env.LARK_CLI_PATH;
        } else {
          process.env.LARK_CLI_PATH = origEnv;
        }
      }
    });

    it('defaults to "lark-cli" when no env var or option', async () => {
      const origEnv = process.env.LARK_CLI_PATH;
      delete process.env.LARK_CLI_PATH;
      try {
        const defaultCli = new LarkCli();
        mockSpawn('ok', '', 0);
        await defaultCli.exec(['--version']);
        expect(spawn).toHaveBeenCalledWith(
          'lark-cli',
          ['--version'],
          expect.any(Object),
        );
      } finally {
        if (origEnv !== undefined) {
          process.env.LARK_CLI_PATH = origEnv;
        }
      }
    });
  });
});
