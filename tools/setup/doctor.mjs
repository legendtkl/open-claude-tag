import { accessSync, constants, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import process from 'process';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const envPath = path.join(repoRoot, '.env');
const nodeModulesPath = path.join(repoRoot, 'node_modules');
const codexConfigPath = path.join(homedir(), '.codex', 'config.toml');

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

function statusLabel(kind) {
  if (kind === 'ok') return 'OK';
  if (kind === 'warn') return 'WARN';
  return 'FAIL';
}

function printResult(kind, title, detail) {
  process.stdout.write(`[${statusLabel(kind)}] ${title}: ${detail}\n`);
}

const env = readEnvFile(envPath);
const checks = [
  {
    kind: process.version.startsWith('v20.') || parseInt(process.versions.node.split('.')[0], 10) > 20 ? 'ok' : 'warn',
    title: 'Node.js',
    detail: `Detected ${process.version}. Recommended: Node.js 20+.`,
  },
  {
    kind: hasCommand('pnpm') ? 'ok' : 'fail',
    title: 'pnpm',
    detail: hasCommand('pnpm')
      ? 'pnpm is available.'
      : 'pnpm is missing. Run `corepack enable` first.',
  },
  {
    kind: existsSync(nodeModulesPath) ? 'ok' : 'warn',
    title: 'Dependencies',
    detail: existsSync(nodeModulesPath)
      ? 'node_modules is present.'
      : 'Dependencies are not installed. Run `pnpm install` before bootstrap commands.',
  },
  {
    kind: hasCommand('docker') && dockerComposeAvailable() ? 'ok' : 'fail',
    title: 'Docker',
    detail:
      hasCommand('docker') && dockerComposeAvailable()
        ? 'Docker and `docker compose` are available.'
        : 'Docker or `docker compose` is missing.',
  },
  {
    kind: existsSync(envPath) ? 'ok' : 'warn',
    title: '.env',
    detail: existsSync(envPath)
      ? '.env exists.'
      : 'No .env found. Copy `.env.example` to `.env` before real Feishu usage.',
  },
  {
    kind:
      env.FEISHU_APP_ID && env.FEISHU_APP_SECRET
        ? 'ok'
        : existsSync(envPath)
          ? 'warn'
          : 'warn',
    title: 'Feishu credentials',
    detail:
      env.FEISHU_APP_ID && env.FEISHU_APP_SECRET
        ? 'FEISHU_APP_ID and FEISHU_APP_SECRET are set.'
        : 'Missing FEISHU_APP_ID or FEISHU_APP_SECRET in .env.',
  },
  {
    kind:
      env.ANTHROPIC_AUTH_TOKEN || canAccessFile(codexConfigPath)
        ? 'ok'
        : 'warn',
    title: 'Runtime credentials',
    detail:
      env.ANTHROPIC_AUTH_TOKEN || canAccessFile(codexConfigPath)
        ? env.ANTHROPIC_AUTH_TOKEN && canAccessFile(codexConfigPath)
          ? 'Claude Code and Codex runtime credentials are available.'
          : env.ANTHROPIC_AUTH_TOKEN
            ? 'Claude Code runtime credentials are available.'
            : 'Codex runtime config is available.'
        : 'No Claude Code token or ~/.codex/config.toml found.',
  },
  {
    kind: hasCommand('psql') && hasCommand('createdb') && hasCommand('dropdb') ? 'ok' : 'warn',
    title: 'PostgreSQL client tools',
    detail:
      hasCommand('psql') && hasCommand('createdb') && hasCommand('dropdb')
        ? 'psql/createdb/dropdb are available for isolated worktree commands.'
        : 'Optional: install psql/createdb/dropdb if you plan to use isolated worktree commands.',
  },
  {
    kind: hasCommand('lark-cli') ? 'ok' : 'warn',
    title: 'lark-cli',
    detail: hasCommand('lark-cli')
      ? 'lark-cli is available.'
      : 'Optional: install lark-cli for `pnpm lark:doctor` and Feishu dev tooling.',
  },
  {
    kind: env.DATABASE_URL ? 'ok' : 'warn',
    title: 'Database URL',
    detail:
      env.DATABASE_URL
        ? 'DATABASE_URL is configured.'
        : 'DATABASE_URL is missing from .env.',
  },
];

process.stdout.write('OpenClaudeTag local environment check\n\n');
for (const check of checks) {
  printResult(check.kind, check.title, check.detail);
}

const failedChecks = checks.filter((check) => check.kind === 'fail').length;
const warningChecks = checks.filter((check) => check.kind === 'warn').length;

process.stdout.write('\nNext steps:\n');
if (!existsSync(envPath)) {
  process.stdout.write('- Run `cp .env.example .env` and fill in Feishu/runtime credentials.\n');
}
if (!existsSync(nodeModulesPath)) {
  process.stdout.write('- Run `pnpm install` before `pnpm setup:local`.\n');
}
const missingRequired = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'].filter((key) => !env[key]);
if (missingRequired.length > 0 && existsSync(envPath)) {
  process.stdout.write(`- Fill in required Feishu fields in \`.env\`: ${missingRequired.join(', ')}.\n`);
}
if (!env.ANTHROPIC_AUTH_TOKEN && !canAccessFile(codexConfigPath)) {
  process.stdout.write('- Configure at least one runtime: set `ANTHROPIC_AUTH_TOKEN` in `.env` or create `~/.codex/config.toml`.\n');
}
if (failedChecks === 0) {
  process.stdout.write('- Run `pnpm setup:local` to bootstrap Postgres, migrations, seed data, and build artifacts.\n');
}
process.stdout.write('- Start the services with `pnpm start:local`.\n');
process.stdout.write('- Verify the API with `curl http://localhost:3000/health`.\n');

process.exit(failedChecks > 0 ? 1 : warningChecks > 0 ? 0 : 0);
