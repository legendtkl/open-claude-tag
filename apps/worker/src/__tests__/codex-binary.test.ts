import { describe, expect, it, vi } from 'vitest';
import { resolveCodexBinaryPath } from '../codex-binary.js';

describe('resolveCodexBinaryPath', () => {
  it('uses CODEX_BINARY_PATH when configured', () => {
    const execFileSyncFn = vi.fn();

    expect(
      resolveCodexBinaryPath({
        env: {
          CODEX_BINARY_PATH: '/custom/codex',
          SHELL: '/bin/zsh',
          PATH: '/usr/local/bin',
        },
        execFileSyncFn,
        isExecutableFn: () => true,
        platform: 'darwin',
      }),
    ).toBe('/custom/codex');
    expect(execFileSyncFn).not.toHaveBeenCalled();
  });

  it('allows an explicit CODEX_BINARY_PATH inside an npx cache', () => {
    const execFileSyncFn = vi.fn();
    const npxCodex = '/Users/dev/.npm/_npx/abc123/node_modules/.bin/codex';

    expect(
      resolveCodexBinaryPath({
        env: {
          CODEX_BINARY_PATH: npxCodex,
          SHELL: '/bin/zsh',
          PATH: '/Users/dev/.npm-global/bin',
        },
        execFileSyncFn,
        isExecutableFn: () => true,
        platform: 'darwin',
      }),
    ).toBe(npxCodex);
    expect(execFileSyncFn).not.toHaveBeenCalled();
  });

  it('uses shell command resolution by default', () => {
    const execFileSyncFn = vi.fn(() => '/Users/dev/.npm-global/bin/codex\n');

    expect(
      resolveCodexBinaryPath({
        env: {
          SHELL: '/bin/zsh',
          PATH: '/usr/local/bin:/Users/dev/.npm-global/bin',
        },
        execFileSyncFn,
        isExecutableFn: (filePath) => filePath === '/Users/dev/.npm-global/bin/codex',
        platform: 'darwin',
      }),
    ).toBe('/Users/dev/.npm-global/bin/codex');
    expect(execFileSyncFn).toHaveBeenCalledWith('/bin/zsh', ['-lc', 'command -v codex'], {
      encoding: 'utf8',
      env: {
        SHELL: '/bin/zsh',
        PATH: '/usr/local/bin:/Users/dev/.npm-global/bin',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  it('skips temporary npx codex shims and falls through to a user install', () => {
    const npxCodex = '/Users/dev/.npm/_npx/abc123/node_modules/.bin/codex';
    const userCodex = '/Users/dev/.npm-global/bin/codex';
    const execFileSyncFn = vi.fn(() => `${npxCodex}\n`);

    expect(
      resolveCodexBinaryPath({
        env: {
          SHELL: '/bin/zsh',
          PATH: `${npxCodex.replace(/\/codex$/, '')}:/Users/dev/.npm-global/bin`,
        },
        execFileSyncFn,
        isExecutableFn: (filePath) => filePath === npxCodex || filePath === userCodex,
        platform: 'darwin',
      }),
    ).toBe(userCodex);
  });

  it('falls back to PATH scanning when shell resolution fails', () => {
    const execFileSyncFn = vi.fn(() => {
      throw new Error('shell failed');
    });

    expect(
      resolveCodexBinaryPath({
        env: {
          SHELL: '/bin/zsh',
          PATH: '/usr/local/bin:/Users/dev/.npm-global/bin',
        },
        execFileSyncFn,
        isExecutableFn: (filePath) => filePath === '/usr/local/bin/codex',
        platform: 'darwin',
      }),
    ).toBe('/usr/local/bin/codex');
  });
});
