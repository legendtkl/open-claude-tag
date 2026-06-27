#!/usr/bin/env node
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs, USAGE } from './personal/args.js';
import { loadEffectiveEnv } from './personal/env.js';
import { resolvePersonalConfig } from './personal/config.js';
import { runUp, runDown, runStatus, formatStatus } from './personal/commands.js';
import { buildUpDeps, buildDownDeps, buildStatusDeps, type RuntimeContext } from './personal/runtime.js';
import { runDbHost } from './personal/db-host.js';

function log(message: string): void {
  process.stdout.write(`[open-claude-tag] ${message}\n`);
}

function resolveRepoRoot(): string {
  if (process.env.OPEN_TAG_REPO_ROOT?.trim()) {
    return resolve(process.env.OPEN_TAG_REPO_ROOT.trim());
  }
  // dist/cli.js → packages/launcher/dist → repo root is three levels up.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.unknown.length > 0) {
    process.stderr.write(`Unknown argument(s): ${args.unknown.join(', ')}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (args.command === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const repoRoot = resolveRepoRoot();
  const effectiveEnv = loadEffectiveEnv(repoRoot);
  const config = resolvePersonalConfig(effectiveEnv, { repoRoot });
  const cliPath = fileURLToPath(import.meta.url);
  const ctx: RuntimeContext = {
    config,
    effectiveEnv,
    cliPath,
    log,
    build: args.build,
    noBuild: args.noBuild,
  };

  if (args.command === 'db-host') {
    await runDbHost(config);
    return;
  }

  if (args.command === 'up') {
    log(`Starting personal stack (db mode: ${config.dbMode}, api :${config.apiPort}, console :${config.consolePort}).`);
    const result = await runUp(config, buildUpDeps(ctx), { noOpen: args.noOpen });
    log(
      result.status === 'already-running'
        ? `Already running. Console: ${config.consoleUrl}`
        : `Up. Console: ${config.consoleUrl}`,
    );
    return;
  }

  if (args.command === 'down') {
    log('Stopping personal stack.');
    await runDown(config, buildDownDeps(ctx));
    log('Down.');
    return;
  }

  if (args.command === 'status') {
    const snapshot = await runStatus(config, buildStatusDeps(ctx));
    process.stdout.write(`${formatStatus(snapshot)}\n`);
    return;
  }
}

// `db-host` is the long-lived Postgres owner and must stay alive; every other
// command is one-shot, so exit explicitly once it resolves (undici's keepalive
// sockets would otherwise keep the process lingering after `up`/`down`/`status`).
const isDbHost = process.argv.slice(2).includes('db-host');
main().then(
  () => {
    if (!isDbHost) process.exit(process.exitCode ?? 0);
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
