import { execFileSync } from 'child_process';
import { accessSync, constants as fsConstants, statSync } from 'fs';
import { delimiter, join } from 'path';

type ShellExecFileSyncFn = (
  file: string,
  args: readonly string[],
  options: {
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'ignore'];
    timeout: number;
    killSignal: 'SIGKILL';
  },
) => string | Buffer;

interface ResolveCocoBinaryPathOptions {
  env?: NodeJS.ProcessEnv;
  execFileSyncFn?: ShellExecFileSyncFn;
  isExecutableFn?: (filePath: string) => boolean;
  platform?: NodeJS.Platform;
}

function isExecutable(filePath: string): boolean {
  try {
    // Require a regular FILE that is executable. Directories pass `X_OK` on
    // POSIX (there the execute bit means "searchable"), so an X_OK-only check
    // would wrongly accept a directory `COCO_BINARY_PATH` and mask the fallback.
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Wrap `command -v coco` between sentinels so rc/profile banners or echoed
// output that the login shell prints cannot be mistaken for the binary path.
// We only trust the text between CC_COCO_BEGIN and CC_COCO_END.
const COCO_PROBE_SCRIPT =
  'printf "CC_COCO_BEGIN\\n%s\\nCC_COCO_END\\n" "$(command -v coco 2>/dev/null)"';

function parseCocoProbeOutput(value: string | Buffer): string | undefined {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  const lines = text.split(/\r?\n/);
  const begin = lines.indexOf('CC_COCO_BEGIN');
  if (begin === -1) return undefined;
  const end = lines.indexOf('CC_COCO_END', begin + 1);
  if (end === -1) return undefined;
  const candidate = lines
    .slice(begin + 1, end)
    .join('\n')
    .trim();
  return candidate || undefined;
}

function hasPathSeparator(filePath: string): boolean {
  return filePath.includes('/') || filePath.includes('\\');
}

function isUsableCocoCandidate(
  candidate: string | undefined,
  options: Required<ResolveCocoBinaryPathOptions>,
): candidate is string {
  if (!candidate || candidate.startsWith('alias ')) {
    return false;
  }
  return !hasPathSeparator(candidate) || options.isExecutableFn(candidate);
}

function resolveFromShell(options: Required<ResolveCocoBinaryPathOptions>): string | undefined {
  if (options.platform === 'win32') {
    return undefined;
  }

  const shell = options.env.SHELL?.trim() || '/bin/sh';
  try {
    // `-ilc` so the user's interactive rc (where the installer adds
    // `~/.local/bin` to PATH) is sourced. A hard 5s timeout with SIGKILL keeps a
    // hung/interactive-waiting rc from blocking worker startup forever:
    // execFileSync's `timeout` alone only sends SIGTERM and then waits, so a
    // TERM-trapping rc could still stall — SIGKILL makes the cap actually hard.
    const output = options.execFileSyncFn(shell, ['-ilc', COCO_PROBE_SCRIPT], {
      encoding: 'utf8',
      env: options.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    const candidate = parseCocoProbeOutput(output);
    // Mirror the daemon: only trust an absolute path from the shell probe. A
    // bare function/builtin name or an alias body is not a usable binary path
    // and would otherwise fail later at spawn time.
    if (!candidate || !candidate.startsWith('/')) return undefined;
    return isUsableCocoCandidate(candidate, options) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function resolveFromPath(options: Required<ResolveCocoBinaryPathOptions>): string | undefined {
  const executableNames =
    options.platform === 'win32' ? ['coco.cmd', 'coco.exe', 'coco'] : ['coco'];
  for (const dir of (options.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const executableName of executableNames) {
      const candidate = join(dir, executableName);
      if (isUsableCocoCandidate(candidate, options)) {
        return candidate;
      }
    }
  }

  return undefined;
}

/**
 * Resolves the `coco` (TRAE CLI) binary path on this machine.
 *
 * Order: `COCO_BINARY_PATH` operator override (only when it points at an
 * executable) → the user's interactive login shell (`command -v coco` under
 * `-ilc`, honoring `~/.zshrc` PATH where the installer adds `~/.local/bin`,
 * sentinel-wrapped and time-boxed so a hung rc can't stall startup) → a plain
 * `PATH` walk. Coco is not an npm dependency, so the npx-shim shadowing that
 * complicates codex resolution does not apply here.
 */
export function resolveCocoBinaryPath(
  options: ResolveCocoBinaryPathOptions = {},
): string | undefined {
  const resolvedOptions: Required<ResolveCocoBinaryPathOptions> = {
    env: options.env ?? process.env,
    execFileSyncFn: options.execFileSyncFn ?? execFileSync,
    isExecutableFn: options.isExecutableFn ?? isExecutable,
    platform: options.platform ?? process.platform,
  };

  // The operator override wins, but only when it actually points at an
  // executable. A directory / non-exec / typo'd `COCO_BINARY_PATH` must not mask
  // the shell+PATH fallback — otherwise coco looks "resolved" at startup and the
  // failure is deferred to spawn time instead of surfacing here.
  const configuredPath = resolvedOptions.env.COCO_BINARY_PATH?.trim();
  if (configuredPath && resolvedOptions.isExecutableFn(configuredPath)) {
    return configuredPath;
  }

  return resolveFromShell(resolvedOptions) ?? resolveFromPath(resolvedOptions);
}
