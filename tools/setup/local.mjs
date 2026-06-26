import { accessSync, constants, copyFileSync, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import process from 'process';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const envPath = path.join(repoRoot, '.env');
const envExamplePath = path.join(repoRoot, '.env.example');
const nodeModulesPath = path.join(repoRoot, 'node_modules');
const codexConfigPath = path.join(homedir(), '.codex', 'config.toml');
const envFromFile = readEnvFile(envPath);

function readEnvFile(filePath) {
  if (!existsSync(filePath)) return {};

  const entries = {};
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

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...envFromFile },
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function waitForPostgresReady(timeoutMs = 60_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = spawnSync(
      'docker',
      ['compose', '-f', 'infra/docker-compose.yaml', 'exec', '-T', 'postgres', 'pg_isready', '-U', 'open-claude-tag'],
      {
        cwd: repoRoot,
        stdio: 'ignore',
      },
    );

    if (result.status === 0) {
      return;
    }

    spawnSync('sh', ['-c', 'sleep 1'], { stdio: 'ignore' });
  }

  process.stderr.write('Postgres did not become ready in time.\n');
  process.exit(1);
}

function hasCommand(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return result.status === 0;
}

function dockerComposeAvailable() {
  const result = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  return result.status === 0;
}

function canAccessFile(filePath) {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

if (!existsSync(envPath) && existsSync(envExamplePath)) {
  copyFileSync(envExamplePath, envPath);
  process.stdout.write('Created .env from .env.example.\n');
}

if (!hasCommand('pnpm')) {
  process.stderr.write('pnpm is missing. Run `corepack enable` first.\n');
  process.exit(1);
}

if (!existsSync(nodeModulesPath)) {
  process.stderr.write('Dependencies are not installed. Run `pnpm install` before `pnpm setup:local`.\n');
  process.exit(1);
}

if (!hasCommand('docker') || !dockerComposeAvailable()) {
  process.stderr.write('Docker with `docker compose` is required for `pnpm setup:local`.\n');
  process.exit(1);
}

process.stdout.write('Starting Postgres...\n');
run('docker', ['compose', '-f', 'infra/docker-compose.yaml', 'up', 'postgres', '-d']);
waitForPostgresReady();

process.stdout.write('Applying database migrations and seed data...\n');
run('pnpm', ['db:setup']);

process.stdout.write('Building packages...\n');
run('pnpm', ['build']);

const env = envFromFile;
const missingRequired = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'].filter((key) => !env[key]);
const hasClaudeRuntime = Boolean(env.ANTHROPIC_AUTH_TOKEN);
const hasCodexRuntime = canAccessFile(codexConfigPath);

process.stdout.write('\nLocal bootstrap complete.\n');
process.stdout.write('Next steps:\n');
if (missingRequired.length > 0) {
  process.stdout.write(`- Fill in required Feishu fields in \`.env\`: ${missingRequired.join(', ')}.\n`);
}
if (!hasClaudeRuntime && !hasCodexRuntime) {
  process.stdout.write('- Configure at least one runtime: set `ANTHROPIC_AUTH_TOKEN` in `.env` or create `~/.codex/config.toml`.\n');
}
process.stdout.write('- Start the services with `pnpm dev:api` and `pnpm dev:worker`.\n');
process.stdout.write('- Run `pnpm doctor:local` for a quick environment check.\n');
