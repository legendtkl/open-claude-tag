import { hostname, platform } from 'os';
import { accessSync, constants as fsConstants, statSync } from 'fs';
import { delimiter, join, sep } from 'path';
import { execFileSync } from 'child_process';
import {
  DAEMON_FEATURE_AGENT_HOME,
  DAEMON_FEATURE_RUNTIME_ENV,
  PROTOCOL_VERSION,
  type Capabilities,
} from '@open-tag/daemon-protocol';
import { DAEMON_VERSION } from './version.js';

/**
 * Capability detection for pairing/`hello` (design §6, D9).
 *
 * The daemon must NOT import worker code (it carries Feishu/DB concerns we never
 * ship to user machines), so the codex-binary probe here is a minimal,
 * dependency-light reimplementation of the worker's `resolveCodexBinaryPath`
 * intent: honor `CODEX_BINARY_PATH`, otherwise walk `PATH`.
 */

interface CapabilitiesProbeEnv {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  CODEX_BINARY_PATH?: string;
  COCO_BINARY_PATH?: string;
  PATH?: string;
  SHELL?: string;
}

export interface CapabilitiesProbeOptions {
  /** Environment to read credentials/PATH from. Defaults to `process.env`. */
  env?: CapabilitiesProbeEnv;
  /** Predicate for whether a codex binary is resolvable. Injectable for tests. */
  hasCodexBinary?: (env: CapabilitiesProbeEnv) => boolean;
  /** Predicate for whether a coco binary is resolvable. Injectable for tests. */
  hasCocoBinary?: (env: CapabilitiesProbeEnv) => boolean;
  /** Predicate for whether a file path is executable. Injectable for tests. */
  isExecutable?: (filePath: string) => boolean;
  /** Host platform override (tests). */
  platform?: string;
  /** Hostname override (tests). */
  hostname?: string;
}

function defaultIsExecutable(filePath: string): boolean {
  try {
    // Require a regular FILE that is executable. Directories pass `X_OK` on
    // POSIX (the execute bit there means "searchable"), so an X_OK-only check
    // would wrongly accept a directory binary override and mask the fallback.
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects whether a global Anthropic credential fallback is present for Claude
 * Code. Claude Code itself is still advertised without this because local
 * `claude` login state and per-agent runtimeEnv credentials are resolved at
 * execution time.
 */
export function hasAnthropicCredentials(env: CapabilitiesProbeEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
}

/**
 * Detects whether a PATH entry belongs to a transient npx / node_modules `.bin`
 * directory rather than a real install location.
 *
 * THIS IS THE LOAD-BEARING FIX for the `npx @open-tag/daemon` SIGKILL bug.
 * The daemon depends on `@openai/codex-sdk`, which transitively installs
 * `@openai/codex` (its own `bin/codex` shim) into the npx execution sandbox.
 * `npx` PREPENDS that sandbox's `node_modules/.bin` to `PATH`, so a naive PATH
 * walk (or `which codex`) resolves the stale, vendored-binary-less npx shim
 * (`@openai/codex@0.115` whose `vendor/.../codex` is an empty dir) instead of
 * the user's real global CLI (`~/.npm-global/bin/codex@0.137`). The SDK then
 * spawns a broken binary → hang → SIGKILL at ~100s.
 *
 * a codex-free runtime never hits this because it carries NO `@openai/codex*` dependency;
 * its `which codex` is therefore never shadowed. We can't drop the SDK without
 * a larger refactor (tracked as the structural follow-up in design §17), so we
 * filter the poisoned dirs out of the search instead — and return the RESOLVED
 * absolute path so a dirty child PATH can never re-redirect the spawn (the same
 * invariant we rely on by spawning the `which`-resolved absolute path).
 */
function isShimPathDir(dir: string): boolean {
  const normalized = dir.split('/').join(sep);
  // npx caches packages under `.../_npx/<hash>/node_modules/.bin`. Match both
  // the npx cache marker and any nested `node_modules/.bin` shim directory.
  return (
    normalized.includes(`${sep}_npx${sep}`) ||
    normalized.includes(`${sep}node_modules${sep}.bin`)
  );
}

/**
 * The shell snippet we run under `-ilc`. `command -v codex` is bracketed by
 * sentinel LINES (not inline angle brackets) so that (a) rc-file banner noise
 * before/after can't be mistaken for the result, and (b) a path containing any
 * character except a newline survives intact. `2>/dev/null` drops shell errors.
 */
const CODEX_PROBE_SCRIPT =
  'printf "CC_CODEX_BEGIN\\n%s\\nCC_CODEX_END\\n" "$(command -v codex 2>/dev/null)"';

/** Extracts the single line the shell printed between the sentinel markers. */
function parseCodexProbeOutput(out: string): string | undefined {
  const lines = out.split('\n');
  const begin = lines.indexOf('CC_CODEX_BEGIN');
  if (begin === -1) return undefined;
  const end = lines.indexOf('CC_CODEX_END', begin + 1);
  if (end === -1) return undefined;
  const value = lines.slice(begin + 1, end).join('\n').trim();
  return value || undefined;
}

/** Runs a shell probe under `-ilc`; SIGKILL on timeout so a rc hang can't stall us. */
function defaultLoginShellExec(shell: string): string {
  return execFileSync(shell, ['-ilc', CODEX_PROBE_SCRIPT], {
    encoding: 'utf8',
    timeout: 5000,
    // execFileSync's `timeout` only sends SIGTERM and then WAITS for exit; an rc
    // file that traps TERM (or blocks on a prompt) would hang the daemon despite
    // the timeout. SIGKILL makes the 5s cap actually hard. (Verified: a TERM-
    // trapping child ignored a 500ms SIGTERM timeout for 10s; SIGKILL cut it.)
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Injectable dependencies for {@link resolveCodexViaLoginShell} (test seams). */
export interface LoginShellResolveDeps {
  /** Runs the probe under a given shell, returning stdout. Defaults to `execFileSync -ilc`. */
  exec?: (shell: string) => string;
  /** Executable-path predicate (shells + the resolved codex). */
  isExecutable?: (filePath: string) => boolean;
  /** Platform override (tests). */
  platform?: NodeJS.Platform;
  /** Shell candidates to try, highest priority first. */
  shellCandidates?: (string | undefined)[];
}

/**
 * Resolves codex the way the user's OWN interactive login shell would — by
 * sourcing their rc files (`~/.zshrc`/`~/.bash_profile`) and asking
 * `command -v codex`.
 *
 * THIS IS THE PRIMARY RESOLUTION PATH, and the load-bearing fix for the
 * wrong-codex bug. A daemon started via `npx`, launchd, or any non-interactive
 * shell inherits a PATH that does NOT match the user's interactive PATH. On a
 * real machine we found THREE codex installs on the login PATH —
 * `/usr/local/bin/codex` (0.79, an old fork the backend 400s for new models),
 * `/opt/homebrew/bin/codex` (0.121), and `~/.npm-global/bin/codex` (0.137) —
 * where only the last is the one the user actually runs, and ONLY because their
 * `~/.zshrc` prepends it. A bare PATH walk (or `which`) from the daemon picks
 * the stale 0.79 (→ backend "model requires a newer Codex" 400) or, under npx,
 * the empty-vendor shim (→ SIGKILL). Sourcing the user's shell reproduces their
 * exact resolution, yielding the codex they've verified works.
 *
 * Tries each shell candidate in turn (the user's `$SHELL` first, then common
 * interactive shells in case the daemon was launched without `SHELL`): a shell
 * whose probe throws (incompatible `-ilc`, broken rc, timeout) does NOT abort
 * resolution — we move to the next candidate before giving up to the PATH walk.
 * Returns undefined on Windows (no POSIX login shell) or when nothing resolves.
 */
export function resolveCodexViaLoginShell(
  env: CapabilitiesProbeEnv,
  deps: LoginShellResolveDeps = {},
): string | undefined {
  const hostPlatform = deps.platform ?? process.platform;
  if (hostPlatform === 'win32') return undefined;
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const exec = deps.exec ?? defaultLoginShellExec;
  const candidates = (deps.shellCandidates ?? [env.SHELL?.trim(), '/bin/zsh', '/bin/bash']).filter(
    (s): s is string => Boolean(s),
  );
  for (const shell of candidates) {
    if (!isExecutable(shell)) continue;
    let out: string;
    try {
      // `-i` (interactive) sources ~/.zshrc (where PATH customizations live);
      // `-l` (login) adds ~/.zprofile.
      out = exec(shell);
    } catch {
      continue; // incompatible shell / rc error / timeout — try the next one.
    }
    const resolved = parseCodexProbeOutput(out);
    // Require an ABSOLUTE path: a `command -v` that resolves to an alias/function/
    // builtin prints a non-path token, which we reject and fall through.
    if (resolved && resolved.startsWith('/') && isExecutable(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

/** Adapts {@link resolveCodexViaLoginShell} to the `resolveCodexBinary` injection seam. */
function defaultResolveViaShell(
  env: CapabilitiesProbeEnv,
  isExecutable: (filePath: string) => boolean,
): string | undefined {
  return resolveCodexViaLoginShell(env, { isExecutable });
}

/**
 * Resolves the codex binary path on this machine.
 *
 * Resolution order (robustness-first):
 *   1. `CODEX_BINARY_PATH` — explicit operator override, always wins.
 *   2. The user's interactive login shell (see {@link resolveCodexViaLoginShell})
 *      — reproduces the exact codex the user runs, respecting `~/.zshrc` PATH.
 *   3. A filtered `PATH` walk that SKIPS transient npx / `node_modules/.bin`
 *      shim directories (see {@link isShimPathDir}).
 *
 * Returning the RESOLVED path (not a boolean) matters: the CodexAdapter passes
 * it to the SDK as `codexPathOverride`. Without it the SDK falls back to its
 * own bundled codex binary, whose version (and default model) can lag the
 * user's installed CLI — observed live as a model-version `400` while the PATH
 * CLI worked fine. The returned path is absolute, so a dirty child PATH can
 * never re-redirect the eventual spawn.
 */
export function resolveCodexBinary(
  env: CapabilitiesProbeEnv = process.env,
  isExecutable: (filePath: string) => boolean = defaultIsExecutable,
  resolveViaShell: (
    env: CapabilitiesProbeEnv,
    isExecutable: (filePath: string) => boolean,
  ) => string | undefined = defaultResolveViaShell,
): string | undefined {
  const configured = env.CODEX_BINARY_PATH?.trim();
  if (configured) {
    return configured;
  }

  const fromShell = resolveViaShell(env, isExecutable);
  if (fromShell) {
    return fromShell;
  }

  const isWindows = process.platform === 'win32';
  const executableNames = isWindows ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
  // Two passes: prefer real install dirs, fall back to shim dirs only if no
  // real codex exists anywhere on PATH. This guarantees the user's global CLI
  // wins over the npx-injected shim while never regressing a machine whose ONLY
  // codex happens to live under a node_modules/.bin (unusual, but don't break).
  let shimFallback: string | undefined;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const shim = isShimPathDir(dir);
    for (const name of executableNames) {
      const candidate = join(dir, name);
      if (!isExecutable(candidate)) continue;
      if (shim) {
        shimFallback ??= candidate;
      } else {
        return candidate;
      }
    }
  }
  return shimFallback;
}

/** Boolean convenience over {@link resolveCodexBinary}. */
export function detectCodexBinary(
  env: CapabilitiesProbeEnv = process.env,
  isExecutable: (filePath: string) => boolean = defaultIsExecutable,
): boolean {
  return resolveCodexBinary(env, isExecutable) !== undefined;
}

// ── Coco (TRAE CLI) binary detection ──────────────────────────────────────────
// Coco is a standalone CLI installed to `~/.local/bin` and is NOT an npm
// dependency, so the npx-shim shadowing that complicates codex resolution does
// not apply. We still prefer the user's interactive login shell so a daemon
// launched without their `~/.zshrc` PATH still finds the `coco` they run.

const COCO_PROBE_SCRIPT =
  'printf "CC_COCO_BEGIN\\n%s\\nCC_COCO_END\\n" "$(command -v coco 2>/dev/null)"';

function parseCocoProbeOutput(out: string): string | undefined {
  const lines = out.split('\n');
  const begin = lines.indexOf('CC_COCO_BEGIN');
  if (begin === -1) return undefined;
  const end = lines.indexOf('CC_COCO_END', begin + 1);
  if (end === -1) return undefined;
  const value = lines.slice(begin + 1, end).join('\n').trim();
  return value || undefined;
}

function defaultCocoLoginShellExec(shell: string): string {
  return execFileSync(shell, ['-ilc', COCO_PROBE_SCRIPT], {
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function resolveCocoViaLoginShell(
  env: CapabilitiesProbeEnv,
  deps: LoginShellResolveDeps = {},
): string | undefined {
  const hostPlatform = deps.platform ?? process.platform;
  if (hostPlatform === 'win32') return undefined;
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const exec = deps.exec ?? defaultCocoLoginShellExec;
  const candidates = (deps.shellCandidates ?? [env.SHELL?.trim(), '/bin/zsh', '/bin/bash']).filter(
    (s): s is string => Boolean(s),
  );
  for (const shell of candidates) {
    if (!isExecutable(shell)) continue;
    let out: string;
    try {
      out = exec(shell);
    } catch {
      continue;
    }
    const resolved = parseCocoProbeOutput(out);
    if (resolved && resolved.startsWith('/') && isExecutable(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

/**
 * Resolves the coco binary path: `COCO_BINARY_PATH` override → user login shell
 * → plain `PATH` walk.
 */
export function resolveCocoBinary(
  env: CapabilitiesProbeEnv = process.env,
  isExecutable: (filePath: string) => boolean = defaultIsExecutable,
  resolveViaShell: (
    env: CapabilitiesProbeEnv,
    isExecutable: (filePath: string) => boolean,
  ) => string | undefined = (e, x) => resolveCocoViaLoginShell(e, { isExecutable: x }),
): string | undefined {
  // Honor the operator override only when it points at an executable. A
  // directory / non-exec / typo'd `COCO_BINARY_PATH` must not mask the
  // shell+PATH fallback — otherwise coco reads as "resolved" here and the
  // failure is deferred to spawn time instead of surfacing at resolution.
  const configured = env.COCO_BINARY_PATH?.trim();
  if (configured && isExecutable(configured)) return configured;

  const fromShell = resolveViaShell(env, isExecutable);
  if (fromShell) return fromShell;

  const isWindows = process.platform === 'win32';
  const executableNames = isWindows ? ['coco.cmd', 'coco.exe', 'coco'] : ['coco'];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of executableNames) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Boolean convenience over {@link resolveCocoBinary}. */
export function detectCocoBinary(
  env: CapabilitiesProbeEnv = process.env,
  isExecutable: (filePath: string) => boolean = defaultIsExecutable,
): boolean {
  return resolveCocoBinary(env, isExecutable) !== undefined;
}

/**
 * Builds the capability descriptor advertised at pairing and on `hello`
 * (design §6, D9). Detects available runtimes, platform/hostname, and the
 * daemon + protocol versions.
 */
export function probeCapabilities(options: CapabilitiesProbeOptions = {}): Capabilities {
  const env = options.env ?? process.env;
  const runtimes: Capabilities['runtimes'] = [];

  // claude_code is always available on the daemon: the Agent SDK ships with the
  // daemon, and local `claude` login state or per-agent BASE_URL/API_KEY are
  // resolved at execution time — no global Anthropic credentials are required at
  // pairing time. This mirrors the server-side de-gated Claude registration.
  // `hasAnthropicCredentials` is retained only as an informational signal for a
  // global fallback.
  runtimes.push('claude_code');

  const codexAvailable = options.hasCodexBinary
    ? options.hasCodexBinary(env)
    : detectCodexBinary(env, options.isExecutable);
  if (codexAvailable) {
    runtimes.push('codex');
  }

  const cocoAvailable = options.hasCocoBinary
    ? options.hasCocoBinary(env)
    : detectCocoBinary(env, options.isExecutable);
  if (cocoAvailable) {
    runtimes.push('coco');
  }

  return {
    runtimes,
    features: [DAEMON_FEATURE_RUNTIME_ENV, DAEMON_FEATURE_AGENT_HOME],
    platform: options.platform ?? platform(),
    hostname: options.hostname ?? hostname(),
    daemonVersion: DAEMON_VERSION,
    protocolVersion: PROTOCOL_VERSION,
  };
}
