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

function resolveDbMode(raw) {
  const value = (raw ?? '').trim();
  if (value === 'docker' || value === 'external' || value === 'embedded') return value;
  // Unknown/unset ⇒ embedded (the launcher default). `up` itself fail-closes on
  // a genuinely invalid value; doctor stays informational and never crashes.
  return 'embedded';
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
const dbMode = resolveDbMode(process.env.OPEN_TAG_DB_MODE ?? env.OPEN_TAG_DB_MODE);
const dockerAvailable = hasCommand('docker') && dockerComposeAvailable();
const pgPort = process.env.OPEN_TAG_PG_PORT ?? env.OPEN_TAG_PG_PORT ?? '5432';
const pgDataDir =
  process.env.OPEN_TAG_PG_DATA_DIR ??
  env.OPEN_TAG_PG_DATA_DIR ??
  path.join(homedir(), '.open-claude-tag', 'pgdata');
const embeddedInitialized = existsSync(path.join(pgDataDir, 'PG_VERSION'));

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
    kind: 'ok',
    title: 'Database mode',
    detail:
      `OPEN_TAG_DB_MODE=${dbMode}.` +
      (dbMode === 'embedded'
        ? ' Zero-Docker: the launcher provisions an embedded Postgres.'
        : dbMode === 'external'
          ? ' Bring-your-own Postgres via DATABASE_URL.'
          : ' Docker Compose Postgres.'),
  },
  {
    // Docker is a hard requirement ONLY for OPEN_TAG_DB_MODE=docker. In embedded
    // or external mode it is a non-blocking note, never a FAIL.
    kind: dbMode === 'docker' ? (dockerAvailable ? 'ok' : 'fail') : dockerAvailable ? 'ok' : 'warn',
    title: 'Docker',
    detail: dockerAvailable
      ? 'Docker and `docker compose` are available.'
      : dbMode === 'docker'
        ? 'Docker or `docker compose` is missing (required for OPEN_TAG_DB_MODE=docker).'
        : `Docker not detected — not required for OPEN_TAG_DB_MODE=${dbMode}.`,
  },
  ...(dbMode === 'embedded'
    ? [
        {
          kind: embeddedInitialized ? 'ok' : 'warn',
          title: 'Embedded Postgres',
          detail: embeddedInitialized
            ? `Initialized data dir ${pgDataDir} (port ${pgPort}).`
            : `Not initialized yet; the first \`up\` will create ${pgDataDir} (port ${pgPort}). No Docker required.`,
        },
      ]
    : []),
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
if (dbMode === 'docker') {
  if (failedChecks === 0) {
    process.stdout.write('- Run `pnpm setup:local` to bootstrap Postgres, migrations, seed data, and build artifacts.\n');
  }
  process.stdout.write('- Start the services with `pnpm start:local`.\n');
} else {
  process.stdout.write(
    `- Boot the whole stack with one command (no Docker): \`node packages/launcher/dist/cli.js up\`.\n`,
  );
  process.stdout.write('- Stop it with `node packages/launcher/dist/cli.js down`.\n');
}
process.stdout.write('- Verify the API with `curl http://localhost:3000/health`.\n');

process.exit(failedChecks > 0 ? 1 : warningChecks > 0 ? 0 : 0);
