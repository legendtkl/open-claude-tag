import { execFileSync } from 'child_process';
import { accessSync, constants as fsConstants } from 'fs';
import { delimiter, join } from 'path';

type ShellExecFileSyncFn = (
  file: string,
  args: readonly string[],
  options: {
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'ignore'];
  },
) => string | Buffer;

interface ResolveCodexBinaryPathOptions {
  env?: NodeJS.ProcessEnv;
  execFileSyncFn?: ShellExecFileSyncFn;
  isExecutableFn?: (filePath: string) => boolean;
  platform?: NodeJS.Platform;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstOutputLine(value: string | Buffer): string | undefined {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function isTemporaryNpxCodexShim(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/.npm/_npx/') && normalized.includes('/node_modules/.bin/codex');
}

function hasPathSeparator(filePath: string): boolean {
  return filePath.includes('/') || filePath.includes('\\');
}

function isUsableCodexCandidate(
  candidate: string | undefined,
  options: Required<ResolveCodexBinaryPathOptions>,
): candidate is string {
  if (!candidate || candidate.startsWith('alias ')) {
    return false;
  }
  if (isTemporaryNpxCodexShim(candidate)) {
    return false;
  }
  return !hasPathSeparator(candidate) || options.isExecutableFn(candidate);
}

function resolveFromShell(options: Required<ResolveCodexBinaryPathOptions>): string | undefined {
  if (options.platform === 'win32') {
    return undefined;
  }

  const shell = options.env.SHELL?.trim() || '/bin/sh';
  try {
    const output = options.execFileSyncFn(shell, ['-lc', 'command -v codex'], {
      encoding: 'utf8',
      env: options.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const candidate = firstOutputLine(output);
    return isUsableCodexCandidate(candidate, options) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function resolveFromPath(options: Required<ResolveCodexBinaryPathOptions>): string | undefined {
  const executableNames =
    options.platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
  for (const dir of (options.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const executableName of executableNames) {
      const candidate = join(dir, executableName);
      if (isUsableCodexCandidate(candidate, options)) {
        return candidate;
      }
    }
  }

  return undefined;
}

export function resolveCodexBinaryPath(
  options: ResolveCodexBinaryPathOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const configuredPath = env.CODEX_BINARY_PATH?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  const resolvedOptions: Required<ResolveCodexBinaryPathOptions> = {
    env,
    execFileSyncFn: options.execFileSyncFn ?? execFileSync,
    isExecutableFn: options.isExecutableFn ?? isExecutable,
    platform: options.platform ?? process.platform,
  };

  return resolveFromShell(resolvedOptions) ?? resolveFromPath(resolvedOptions);
}
