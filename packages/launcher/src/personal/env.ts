import { copyFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Parse a `.env` file into a plain record. Mirrors the lightweight parser used
 * by `tools/setup/{doctor,local}.mjs` so the launcher reads `.env` the same way
 * the rest of the tooling does: `KEY=value`, `#` comments, blank lines skipped.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

export interface EffectiveEnvDeps {
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
}

/**
 * Compute the launcher's effective environment: the repo `.env` overlaid by the
 * real process environment, so the SHELL wins over the FILE. This is the same
 * precedence Node's `--env-file` uses (the api/worker dev scripts boot with
 * `--env-file=../../.env`), so the launcher and the services it spawns resolve
 * the same values — a single, explicit merge order.
 */
export function loadEffectiveEnv(
  repoRoot: string,
  processEnv: NodeJS.ProcessEnv = process.env,
  deps: EffectiveEnvDeps = {},
): NodeJS.ProcessEnv {
  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const envPath = join(repoRoot, '.env');
  const fromFile = fileExists(envPath) ? parseEnvFile(readFile(envPath)) : {};
  return { ...fromFile, ...processEnv };
}

export interface EnsureEnvFileDeps {
  fileExists?: (path: string) => boolean;
  copyFile?: (from: string, to: string) => void;
}

/**
 * Ensure a repo `.env` exists so the api/worker dev scripts' `--env-file` does
 * not fail. Copies `.env.example` when `.env` is missing (mirrors
 * `tools/setup/local.mjs`). Returns whether a new file was created.
 */
export function ensureEnvFile(repoRoot: string, deps: EnsureEnvFileDeps = {}): boolean {
  const fileExists = deps.fileExists ?? existsSync;
  const copyFile = deps.copyFile ?? copyFileSync;
  const envPath = join(repoRoot, '.env');
  const examplePath = join(repoRoot, '.env.example');
  if (fileExists(envPath)) return false;
  if (!fileExists(examplePath)) return false;
  copyFile(examplePath, envPath);
  return true;
}
