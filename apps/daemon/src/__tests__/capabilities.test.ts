import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import {
  probeCapabilities,
  hasAnthropicCredentials,
  detectCodexBinary,
  resolveCodexBinary,
  resolveCodexViaLoginShell,
  detectCocoBinary,
  resolveCocoBinary,
  resolveCocoViaLoginShell,
} from '../capabilities.js';
import {
  DAEMON_FEATURE_AGENT_HOME,
  DAEMON_FEATURE_RUNTIME_ENV,
  PROTOCOL_VERSION,
} from '@open-tag/daemon-protocol';
import { DAEMON_VERSION } from '../version.js';

describe('capabilities probe', () => {
  it('detects only global Claude credential fallback env, not Base URL alone', () => {
    expect(hasAnthropicCredentials({ ANTHROPIC_API_KEY: 'sk-test' })).toBe(true);
    expect(hasAnthropicCredentials({ ANTHROPIC_AUTH_TOKEN: 'token' })).toBe(true);
    expect(hasAnthropicCredentials({ ANTHROPIC_BASE_URL: 'https://api' })).toBe(false);
    expect(hasAnthropicCredentials({})).toBe(false);
  });

  it('detects codex from CODEX_BINARY_PATH without touching the filesystem', () => {
    expect(detectCodexBinary({ CODEX_BINARY_PATH: '/opt/codex' }, () => false)).toBe(true);
  });

  it('detects codex by walking PATH with an injected executable predicate', () => {
    const env = { PATH: '/a:/b' };
    const isExec = (p: string) => p === '/b/codex';
    expect(detectCodexBinary(env, isExec)).toBe(true);
    expect(detectCodexBinary({ PATH: '/a' }, isExec)).toBe(false);
  });

  it('detects coco from an executable COCO_BINARY_PATH', () => {
    expect(detectCocoBinary({ COCO_BINARY_PATH: '/opt/coco' }, (p) => p === '/opt/coco')).toBe(
      true,
    );
  });

  it('ignores a non-executable COCO_BINARY_PATH and falls through to PATH', () => {
    // The override must point at a real executable; a stale / typo'd / directory
    // path must not mask shell+PATH resolution (else coco reads as "resolved"
    // and fails later at spawn time instead of here).
    expect(detectCocoBinary({ COCO_BINARY_PATH: '/opt/coco', PATH: '/x' }, () => false)).toBe(
      false,
    );
  });

  it('detects coco by walking PATH with an injected executable predicate', () => {
    const env = { PATH: '/a:/b' };
    const isExec = (p: string) => p === '/b/coco';
    expect(detectCocoBinary(env, isExec)).toBe(true);
    expect(detectCocoBinary({ PATH: '/a' }, isExec)).toBe(false);
  });

  it('honors COCO_BINARY_PATH above any PATH resolution', () => {
    expect(resolveCocoBinary({ COCO_BINARY_PATH: '/opt/coco', PATH: '/x' }, () => true)).toBe(
      '/opt/coco',
    );
  });

  it('rejects a directory COCO_BINARY_PATH via the real executable check', () => {
    // A directory passes X_OK on POSIX; the default executable check must also
    // require a regular file, so a directory override falls through. Inject a
    // no-op shell resolver so the real login shell is never spawned in the test.
    expect(
      resolveCocoBinary({ COCO_BINARY_PATH: tmpdir(), PATH: '' }, undefined, () => undefined),
    ).toBeUndefined();
  });

  it('advertises all three runtimes, platform/hostname, and versions', () => {
    const caps = probeCapabilities({
      env: { ANTHROPIC_BASE_URL: 'https://api', CODEX_BINARY_PATH: '/opt/codex' },
      hasCodexBinary: () => true,
      hasCocoBinary: () => true,
      platform: 'linux',
      hostname: 'box',
    });
    expect(caps.runtimes.sort()).toEqual(['claude_code', 'coco', 'codex']);
    expect(caps.platform).toBe('linux');
    expect(caps.hostname).toBe('box');
    expect(caps.daemonVersion).toBe(DAEMON_VERSION);
    expect(caps.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(caps.features).toEqual([DAEMON_FEATURE_RUNTIME_ENV, DAEMON_FEATURE_AGENT_HOME]);
  });

  it('always advertises claude_code, gating only codex/coco on their binaries', () => {
    // Per-agent BASE_URL/API_KEY are supplied at dispatch via runtimeEnv, so the
    // daemon must advertise claude_code regardless of global env (mirrors the
    // server-side de-gated Claude registration). Codex and coco still gate on
    // their binaries, so with neither present only claude_code is advertised.
    const caps = probeCapabilities({
      env: {},
      hasCodexBinary: () => false,
      hasCocoBinary: () => false,
    });
    expect(caps.runtimes).toEqual(['claude_code']);
  });
});

describe('resolveCodexBinary npx-shim filtering', () => {
  it('honors CODEX_BINARY_PATH above any PATH resolution', () => {
    expect(resolveCodexBinary({ CODEX_BINARY_PATH: '/opt/codex', PATH: '/x' }, () => true)).toBe(
      '/opt/codex',
    );
  });

  it('skips the npx-injected node_modules/.bin shim in favor of the real global codex', () => {
    // Reproduces the prod bug: npx prepends its sandbox .bin to PATH, shadowing
    // the user's real global CLI. The real codex must still win.
    const env = {
      PATH: '/home/u/.npx/_npx/abc123/node_modules/.bin:/home/u/.npm-global/bin:/usr/local/bin',
    };
    const isExec = (p: string) =>
      p === '/home/u/.npx/_npx/abc123/node_modules/.bin/codex' ||
      p === '/home/u/.npm-global/bin/codex';
    expect(resolveCodexBinary(env, isExec)).toBe('/home/u/.npm-global/bin/codex');
  });

  it('skips a plain node_modules/.bin shim even without an _npx marker', () => {
    const env = { PATH: '/proj/node_modules/.bin:/usr/local/bin' };
    const isExec = (p: string) =>
      p === '/proj/node_modules/.bin/codex' || p === '/usr/local/bin/codex';
    expect(resolveCodexBinary(env, isExec)).toBe('/usr/local/bin/codex');
  });

  it('falls back to the shim codex only when no real codex exists on PATH', () => {
    const env = { PATH: '/proj/node_modules/.bin:/usr/local/bin' };
    const isExec = (p: string) => p === '/proj/node_modules/.bin/codex';
    expect(resolveCodexBinary(env, isExec)).toBe('/proj/node_modules/.bin/codex');
  });

  it('returns undefined when no codex is resolvable anywhere', () => {
    const noShell = () => undefined;
    expect(resolveCodexBinary({ PATH: '/a:/b' }, () => false, noShell)).toBeUndefined();
  });

  it('prefers the login-shell-resolved codex over a PATH-walk hit', () => {
    // The user's ~/.zshrc puts ~/.npm-global/bin (0.137) first, but the daemon
    // PATH would resolve /usr/local/bin (0.79). The shell result must win.
    const env = { PATH: '/usr/local/bin' };
    const isExec = (p: string) =>
      p === '/usr/local/bin/codex' || p === '/home/u/.npm-global/bin/codex';
    const viaShell = () => '/home/u/.npm-global/bin/codex';
    expect(resolveCodexBinary(env, isExec, viaShell)).toBe('/home/u/.npm-global/bin/codex');
  });

  it('falls back to the filtered PATH walk when the login shell yields nothing', () => {
    const env = { PATH: '/usr/local/bin' };
    const isExec = (p: string) => p === '/usr/local/bin/codex';
    const viaShell = () => undefined;
    expect(resolveCodexBinary(env, isExec, viaShell)).toBe('/usr/local/bin/codex');
  });

  it('lets CODEX_BINARY_PATH override even a login-shell result', () => {
    const viaShell = () => '/home/u/.npm-global/bin/codex';
    expect(resolveCodexBinary({ CODEX_BINARY_PATH: '/opt/codex' }, () => true, viaShell)).toBe(
      '/opt/codex',
    );
  });
});

describe('resolveCodexViaLoginShell', () => {
  const marker = (path: string) => `CC_CODEX_BEGIN\n${path}\nCC_CODEX_END\n`;
  const linux: NodeJS.Platform = 'linux';

  it('parses the sentinel-bracketed path, ignoring rc-file banner noise', () => {
    const out = `Welcome to your shell!\nnvm: loaded\n${marker('/home/u/.npm-global/bin/codex')}done\n`;
    const got = resolveCodexViaLoginShell(
      { SHELL: '/bin/zsh' },
      {
        platform: linux,
        exec: () => out,
        isExecutable: (p) => p === '/bin/zsh' || p === '/home/u/.npm-global/bin/codex',
      },
    );
    expect(got).toBe('/home/u/.npm-global/bin/codex');
  });

  it('accepts a path containing ">" (sentinel lines, not inline brackets)', () => {
    const weird = '/home/u/weird>dir/codex';
    const got = resolveCodexViaLoginShell(
      { SHELL: '/bin/zsh' },
      { platform: linux, exec: () => marker(weird), isExecutable: (p) => p === '/bin/zsh' || p === weird },
    );
    expect(got).toBe(weird);
  });

  it('returns undefined when command -v found nothing (empty between markers)', () => {
    const got = resolveCodexViaLoginShell(
      { SHELL: '/bin/zsh' },
      { platform: linux, exec: () => marker(''), isExecutable: (p) => p === '/bin/zsh' },
    );
    expect(got).toBeUndefined();
  });

  it('rejects a non-absolute token (alias/function/builtin)', () => {
    const got = resolveCodexViaLoginShell(
      { SHELL: '/bin/zsh' },
      {
        platform: linux,
        exec: () => marker('codex: aliased to mycodex'),
        isExecutable: (p) => p === '/bin/zsh',
      },
    );
    expect(got).toBeUndefined();
  });

  it('tries the next shell candidate when the first shell probe throws', () => {
    const calls: string[] = [];
    const got = resolveCodexViaLoginShell(
      { SHELL: '/bin/fish' },
      {
        platform: linux,
        isExecutable: (p) =>
          p === '/bin/fish' || p === '/bin/zsh' || p === '/home/u/.npm-global/bin/codex',
        exec: (shell) => {
          calls.push(shell);
          if (shell === '/bin/fish') throw new Error('fish has no -ilc');
          return marker('/home/u/.npm-global/bin/codex');
        },
      },
    );
    expect(got).toBe('/home/u/.npm-global/bin/codex');
    expect(calls).toEqual(['/bin/fish', '/bin/zsh']);
  });

  it('skips a non-executable shell candidate without probing it', () => {
    const calls: string[] = [];
    const got = resolveCodexViaLoginShell(
      {},
      {
        platform: linux,
        // SHELL unset → candidates fall back to /bin/zsh, /bin/bash; only bash exists.
        isExecutable: (p) => p === '/bin/bash' || p === '/usr/bin/codex',
        exec: (shell) => {
          calls.push(shell);
          return marker('/usr/bin/codex');
        },
      },
    );
    expect(got).toBe('/usr/bin/codex');
    expect(calls).toEqual(['/bin/bash']); // /bin/zsh was skipped (not executable)
  });

  it('returns undefined on Windows without spawning any shell', () => {
    let spawned = false;
    const got = resolveCodexViaLoginShell(
      { SHELL: 'C:/cmd.exe' },
      {
        platform: 'win32',
        isExecutable: () => true,
        exec: () => {
          spawned = true;
          return marker('C:/codex.exe');
        },
      },
    );
    expect(got).toBeUndefined();
    expect(spawned).toBe(false);
  });
});

describe('resolveCocoViaLoginShell', () => {
  const marker = (path: string) => `CC_COCO_BEGIN\n${path}\nCC_COCO_END\n`;
  const linux: NodeJS.Platform = 'linux';

  it('parses the sentinel-bracketed path, ignoring rc-file banner noise', () => {
    const out = `Welcome!\nnvm: loaded\n${marker('/home/u/.local/bin/coco')}done\n`;
    const got = resolveCocoViaLoginShell(
      { SHELL: '/bin/zsh' },
      {
        platform: linux,
        exec: () => out,
        isExecutable: (p) => p === '/bin/zsh' || p === '/home/u/.local/bin/coco',
      },
    );
    expect(got).toBe('/home/u/.local/bin/coco');
  });

  it('rejects a non-absolute token (alias/function/builtin)', () => {
    const got = resolveCocoViaLoginShell(
      { SHELL: '/bin/zsh' },
      {
        platform: linux,
        exec: () => marker('coco: aliased to mycoco'),
        isExecutable: (p) => p === '/bin/zsh',
      },
    );
    expect(got).toBeUndefined();
  });
});
