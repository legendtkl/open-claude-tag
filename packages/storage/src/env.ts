import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_DATABASE_URL = 'postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag';

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};

  const entries: Record<string, string> = {};
  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    entries[key] = value;
  }
  return entries;
}

function findNearestEnvFile(startDir: string): string | null {
  let currentDir = startDir;

  while (true) {
    const candidate = join(currentDir, '.env');
    if (existsSync(candidate)) return candidate;

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function resolveDatabaseUrl(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  importMetaUrl?: string;
} = {}): string {
  const env = options.env ?? process.env;
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }

  const importDir = options.importMetaUrl
    ? dirname(fileURLToPath(options.importMetaUrl))
    : process.cwd();
  const searchDir = options.cwd ?? importDir;
  const envPath = findNearestEnvFile(searchDir);
  if (!envPath) {
    return DEFAULT_DATABASE_URL;
  }

  return parseEnvFile(envPath).DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

