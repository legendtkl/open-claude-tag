import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { resolveCocoBinaryPath } from '../coco-binary.js';

const sentinel = (path: string): string => `CC_COCO_BEGIN\n${path}\nCC_COCO_END\n`;

describe('resolveCocoBinaryPath', () => {
  it('uses COCO_BINARY_PATH when configured and executable', () => {
    const execFileSyncFn = vi.fn();

    expect(
      resolveCocoBinaryPath({
        env: {
          COCO_BINARY_PATH: '/custom/coco',
          SHELL: '/bin/zsh',
          PATH: '/usr/local/bin',
        },
        execFileSyncFn,
        isExecutableFn: () => true,
        platform: 'darwin',
      }),
    ).toBe('/custom/coco');
    expect(execFileSyncFn).not.toHaveBeenCalled();
  });

  it('ignores COCO_BINARY_PATH when it is not executable and falls through', () => {
    // A directory / non-exec / typo'd override must not mask the shell fallback.
    const execFileSyncFn = vi.fn(() => sentinel('/Users/dev/.local/bin/coco'));

    expect(
      resolveCocoBinaryPath({
        env: {
          COCO_BINARY_PATH: '/custom/not-a-binary',
          SHELL: '/bin/zsh',
          PATH: '/usr/local/bin:/Users/dev/.local/bin',
        },
        execFileSyncFn,
        isExecutableFn: (filePath) => filePath === '/Users/dev/.local/bin/coco',
        platform: 'darwin',
      }),
    ).toBe('/Users/dev/.local/bin/coco');
    expect(execFileSyncFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a directory COCO_BINARY_PATH via the real executable check', () => {
    // A directory passes X_OK on POSIX, so the override resolver must also
    // require a regular file — otherwise a directory path masks the fallback.
    // No isExecutableFn injected here: this exercises the production check.
    const execFileSyncFn = vi.fn(() => sentinel('')); // shell finds nothing
    expect(
      resolveCocoBinaryPath({
        env: { COCO_BINARY_PATH: tmpdir(), SHELL: '/bin/zsh', PATH: '' },
        execFileSyncFn,
        platform: 'darwin',
      }),
    ).toBeUndefined();
  });

  it('rejects a non-absolute shell probe result and falls through', () => {
    // `command -v coco` resolving to a bare function/builtin name (not a path)
    // must not be treated as the binary, mirroring the daemon resolver.
    const execFileSyncFn = vi.fn(() => sentinel('coco'));
    expect(
      resolveCocoBinaryPath({
        env: { SHELL: '/bin/zsh', PATH: '' },
        execFileSyncFn,
        isExecutableFn: () => true,
        platform: 'darwin',
      }),
    ).toBeUndefined();
  });

  it('uses an interactive login shell probe with a hard timeout', () => {
    const execFileSyncFn = vi.fn(() => sentinel('/Users/dev/.local/bin/coco'));

    expect(
      resolveCocoBinaryPath({
        env: {
          SHELL: '/bin/zsh',
          PATH: '/usr/local/bin:/Users/dev/.local/bin',
        },
        execFileSyncFn,
        isExecutableFn: (filePath) => filePath === '/Users/dev/.local/bin/coco',
        platform: 'darwin',
      }),
    ).toBe('/Users/dev/.local/bin/coco');
    expect(execFileSyncFn).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-ilc', 'printf "CC_COCO_BEGIN\\n%s\\nCC_COCO_END\\n" "$(command -v coco 2>/dev/null)"'],
      {
        encoding: 'utf8',
        env: {
          SHELL: '/bin/zsh',
          PATH: '/usr/local/bin:/Users/dev/.local/bin',
        },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        killSignal: 'SIGKILL',
      },
    );
  });

  it('ignores rc/profile banner noise printed before the sentinel block', () => {
    const execFileSyncFn = vi.fn(
      () => `Welcome to your shell!\nnvm: using node 20\n${sentinel('/Users/dev/.local/bin/coco')}`,
    );

    expect(
      resolveCocoBinaryPath({
        env: {
          SHELL: '/bin/zsh',
          PATH: '/usr/local/bin:/Users/dev/.local/bin',
        },
        execFileSyncFn,
        isExecutableFn: (filePath) => filePath === '/Users/dev/.local/bin/coco',
        platform: 'darwin',
      }),
    ).toBe('/Users/dev/.local/bin/coco');
  });

  it('falls back to PATH scanning when the shell probe throws', () => {
    const execFileSyncFn = vi.fn(() => {
      throw new Error('shell failed');
    });

    expect(
      resolveCocoBinaryPath({
        env: {
          SHELL: '/bin/zsh',
          PATH: '/usr/local/bin:/Users/dev/.local/bin',
        },
        execFileSyncFn,
        isExecutableFn: (filePath) => filePath === '/Users/dev/.local/bin/coco',
        platform: 'darwin',
      }),
    ).toBe('/Users/dev/.local/bin/coco');
  });

  it('returns undefined when coco is nowhere resolvable', () => {
    const execFileSyncFn = vi.fn(() => sentinel(''));
    expect(
      resolveCocoBinaryPath({
        env: { SHELL: '/bin/zsh', PATH: '/usr/local/bin' },
        execFileSyncFn,
        isExecutableFn: () => false,
        platform: 'darwin',
      }),
    ).toBeUndefined();
  });
});
