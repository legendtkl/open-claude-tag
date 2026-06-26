import { Command } from 'commander';
import { DAEMON_VERSION } from './version.js';
import { logger } from './logger.js';
import {
  ensureDataDirs,
  readConfig,
  writeConfig,
  resolveConfigPath,
  isConfigSecure,
  redactConfig,
  type DaemonConfig,
} from './config.js';
import { probeCapabilities, hasAnthropicCredentials, detectCodexBinary } from './capabilities.js';
import { pair, PairError } from './pair.js';
import { probeServer, checkWorkspaceWritable, type CheckResult } from './checks.js';
import { buildRuntimeManager } from './runtime-registry.js';
import { ConnectionManager, FatalConnectionError } from './connection.js';
import { PROTOCOL_VERSION } from '@open-tag/daemon-protocol';
import {
  BackgroundProcessError,
  backgroundStatus,
  clearBackgroundPid,
  markBackgroundFailed,
  markBackgroundReady,
  startBackgroundDaemon,
  stopBackgroundDaemon,
} from './background.js';

/** Console output helper (CLI UX is plain stdout/stderr, not the JSON logger). */
function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function clearBackgroundPidIfNeeded(): Promise<void> {
  if (process.env.OPEN_TAG_DAEMON_BACKGROUND_CHILD !== '1') return;
  try {
    await clearBackgroundPid();
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'Could not clear daemon pid file');
  }
}

async function markBackgroundReadyIfNeeded(): Promise<void> {
  if (process.env.OPEN_TAG_DAEMON_BACKGROUND_CHILD !== '1') return;
  try {
    await markBackgroundReady();
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'Could not mark daemon ready');
  }
}

async function markBackgroundFailedIfNeeded(error: string): Promise<void> {
  if (process.env.OPEN_TAG_DAEMON_BACKGROUND_CHILD !== '1') return;
  try {
    await markBackgroundFailed(error);
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'Could not mark daemon failed');
  }
}

function printBackgroundStart(result: Awaited<ReturnType<typeof startBackgroundDaemon>>): void {
  if (result.started) {
    out(`Daemon started in the background (pid ${result.pid}).`);
  } else {
    out(`Daemon is already running in the background (pid ${result.pid}).`);
  }
  if (!result.ready) {
    out('Daemon is still connecting; use "open-claude-tag-daemon status" to check readiness.');
  }
  out(`Logs: ${result.logPath}`);
}

function printBackgroundStartError(e: unknown): void {
  if (e instanceof BackgroundProcessError) {
    err(e.message);
    return;
  }
  throw e;
}

/** `connect`: pair with the server and persist credentials 0600. */
async function runConnect(opts: {
  server: string;
  token: string;
  name?: string;
}): Promise<number> {
  const config = await connectAndPersist(opts);
  if (!config) return 1;
  out('Run "open-claude-tag-daemon start" to begin executing tasks.');
  return 0;
}

async function connectAndPersist(opts: {
  server: string;
  token: string;
  name?: string;
}): Promise<DaemonConfig | null> {
  const capabilities = probeCapabilities();
  out(`Detected runtimes: ${capabilities.runtimes.join(', ') || '(none)'}`);
  if (capabilities.runtimes.length === 0) {
    err('Warning: no runtimes detected. Install codex or coco before starting.');
  }

  let response;
  try {
    response = await pair({
      serverUrl: opts.server,
      token: opts.token,
      name: opts.name,
      capabilities,
    });
  } catch (e) {
    if (e instanceof PairError) {
      err(e.message);
      return null;
    }
    throw e;
  }

  const config: DaemonConfig = {
    serverUrl: opts.server,
    machineId: response.machineId,
    machineSecret: response.machineSecret,
    name: response.machineName,
  };
  await writeConfig(config);
  out(`Paired successfully. Machine id: ${config.machineId}`);
  out(`Credentials written to ${resolveConfigPath()} (mode 0600).`);
  const dirs = await ensureDataDirs();
  out(`Data directories ready: ${dirs.agentsDir} (agent homes), ${dirs.workspacesDir} (scratch).`);
  return config;
}

/** `install`: one-command pair + start, with optional background detach. */
async function runInstall(opts: {
  serverUrl?: string;
  server?: string;
  token?: string;
  apiKey?: string;
  name?: string;
  background?: boolean;
}): Promise<number> {
  const server = opts.serverUrl ?? opts.server;
  const token = opts.token ?? opts.apiKey;
  if (!server) {
    err('Missing required option --server-url <url>.');
    return 1;
  }
  if (!token) {
    err('Missing required option --token <token> (or --api-key <token>).');
    return 1;
  }

  if (opts.background) {
    const existing = await backgroundStatus();
    if (existing.unverified) {
      err(
        `Refusing to pair while ${existing.pidPath} points to an unverified running process (pid ${existing.pid}). Stop that process manually and remove the pid file first.`,
      );
      return 1;
    }
  }

  const config = await connectAndPersist({ server, token, name: opts.name });
  if (!config) return 1;

  if (opts.background) {
    try {
      const started = await startBackgroundDaemon({ restartExisting: true });
      printBackgroundStart(started);
      return 0;
    } catch (e) {
      printBackgroundStartError(e);
      return 1;
    }
  }

  out('Starting daemon in the foreground. Press Ctrl+C to stop.');
  return runStart({ background: false });
}

/** `start`: foreground daemon — connect/hello/heartbeat + dispatch executor. */
async function runStart(opts: { background?: boolean } = {}): Promise<number> {
  const config = await readConfig();
  if (!config) {
    err('No daemon config found. Run "open-claude-tag-daemon connect" first.');
    return 1;
  }

  if (opts.background) {
    try {
      const started = await startBackgroundDaemon();
      printBackgroundStart(started);
      return 0;
    } catch (e) {
      printBackgroundStartError(e);
      return 1;
    }
  }

  const runtimeManager = buildRuntimeManager();
  const connection = new ConnectionManager({
    config,
    runtimeManager,
    onReady: () => {
      void markBackgroundReadyIfNeeded();
    },
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    out(`\nReceived ${signal}; shutting down gracefully...`);
    connection
      .stop()
      .then(() => clearBackgroundPidIfNeeded())
      .then(() => process.exit(0))
      .catch((e) => {
        logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Shutdown error');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  out(`Starting OpenClaudeTag daemon "${config.name}" (v${DAEMON_VERSION}).`);
  out(`Server: ${config.serverUrl}`);
  try {
    await connection.run();
    await clearBackgroundPidIfNeeded();
    return 0;
  } catch (e) {
    await markBackgroundFailedIfNeeded(e instanceof Error ? e.message : String(e));
    await clearBackgroundPidIfNeeded();
    if (e instanceof FatalConnectionError) {
      err(e.message);
      return e.exitCode;
    }
    throw e;
  }
}

/** `status`: config summary (secret redacted) + reachability + protocol. */
async function runStatus(): Promise<number> {
  const config = await readConfig();
  if (!config) {
    err('No daemon config found. Run "open-claude-tag-daemon connect" first.');
    return 1;
  }
  const redacted = redactConfig(config);
  out('Configuration:');
  out(`  name:       ${redacted.name}`);
  out(`  serverUrl:  ${redacted.serverUrl}`);
  out(`  machineId:  ${redacted.machineId}`);
  out(`  secret:     ${redacted.machineSecret}`);
  out(`  configFile: ${resolveConfigPath()} (mode 0600: ${await isConfigSecure()})`);

  const bg = await backgroundStatus();
  out('');
  out('Background process:');
  out(`  running: ${bg.running}`);
  out(`  pid:     ${bg.pid ?? '(none)'}`);
  out(`  stale:   ${bg.stale}`);
  out(`  verified:${!bg.unverified}`);
  out(`  ready:   ${bg.ready}`);
  out(`  state:   ${bg.state ?? '(none)'}`);
  out(`  logFile: ${bg.logPath}`);

  out('');
  out('Server:');
  // Read-only REST probe (GET /daemon/health + /daemon/whoami). Never opens the
  // execution WebSocket, so it cannot supersede a running daemon (finding #3).
  const probe = await probeServer(config);
  out(`  reachable:           ${probe.reachable}`);
  out(`  protocol compatible: ${probe.protocolCompatible} (daemon speaks v${PROTOCOL_VERSION})`);
  out(`  credentials valid:   ${probe.credentialsValid}`);
  out(`  detail:              ${probe.detail}`);
  return probe.reachable && probe.credentialsValid ? 0 : 1;
}

/** `stop`: terminate the background daemon started by `start --background`. */
async function runStop(): Promise<number> {
  const stopped = await stopBackgroundDaemon();
  if (stopped.stopped) {
    out(`Stopped background daemon (pid ${stopped.pid}).`);
    return 0;
  }
  if (stopped.unverified) {
    err(
      `Refusing to stop unverified process pid ${stopped.pid}. Stop it manually if it is a daemon, then remove ${stopped.pidPath}.`,
    );
    return 1;
  }
  if (stopped.running) {
    err(`Background daemon did not stop within the timeout (pid ${stopped.pid}).`);
    return 1;
  }
  out('No running background daemon found.');
  return 0;
}

/** `doctor`: distinct checks; non-zero exit when any fails. */
async function runDoctor(): Promise<number> {
  const results: CheckResult[] = [];

  const config = await readConfig();
  results.push({
    name: 'config present',
    ok: Boolean(config),
    detail: config ? resolveConfigPath() : 'run "open-claude-tag-daemon connect" first',
  });
  if (config) {
    results.push({
      name: 'config mode 0600',
      ok: await isConfigSecure(),
      detail: resolveConfigPath(),
    });
  }

  if (config) {
    // Read-only REST probe — never opens the execution WS (finding #3), so
    // running `doctor` against a live daemon cannot supersede it.
    const probe = await probeServer(config);
    results.push({ name: 'server reachable', ok: probe.reachable, detail: probe.detail });
    results.push({
      name: 'protocol compatible',
      ok: probe.reachable && probe.protocolCompatible,
      detail: probe.reachable
        ? `${probe.detail}; daemon speaks v${PROTOCOL_VERSION}`
        : `cannot verify (server unreachable); daemon speaks v${PROTOCOL_VERSION}`,
    });
    results.push({
      name: 'credentials valid',
      ok: probe.reachable && probe.credentialsValid,
      detail: probe.reachable
        ? probe.detail
        : 'cannot verify (server unreachable)',
    });
  }

  const claudeGlobalFallback = hasAnthropicCredentials();
  const claude = true;
  const codex = detectCodexBinary();
  results.push({
    name: 'runtime: claude_code',
    ok: claude,
    detail: claudeGlobalFallback
      ? 'available; global Anthropic credentials set'
      : 'available via local Claude login or per-agent credentials',
  });
  results.push({
    name: 'runtime: codex',
    ok: codex,
    detail: codex ? 'codex binary resolvable' : 'no codex binary on PATH / CODEX_BINARY_PATH',
  });
  // At least one runtime must be available for the daemon to be useful.
  results.push({
    name: 'at least one runtime',
    ok: claude || codex,
    detail: claude || codex ? 'ok' : 'no runtime available — dispatches would fail',
  });

  results.push(await checkWorkspaceWritable());

  out('Doctor checks:');
  let allOk = true;
  for (const r of results) {
    out(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}: ${r.detail}`);
    if (!r.ok) allOk = false;
  }
  out('');
  out(allOk ? 'All checks passed.' : 'One or more checks failed.');
  return allOk ? 0 : 1;
}

/** Builds the commander program. Exposed for tests. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('open-claude-tag-daemon')
    .description(
      'OpenClaudeTag remote execution daemon — runs tasks on your machine via an outbound WebSocket to a central server.',
    )
    .version(DAEMON_VERSION)
    .option('--server-url <url>', 'One-command install server URL')
    .option('--api-key <token>', 'One-command install pairing token alias')
    .option('--token <token>', 'One-command install pairing token')
    .option('--name <name>', 'Friendly name for this machine')
    .option('--background', 'Start in the background after pairing')
    .action(async (opts) => {
      if (opts.serverUrl || opts.apiKey || opts.token) {
        process.exitCode = await runInstall(opts);
        return;
      }
      program.help();
    });

  program
    .command('connect')
    .description('Pair this machine with a OpenClaudeTag server using a one-time token')
    .requiredOption('--server <url>', 'Server base URL (e.g. https://open-claude-tag.example.com)')
    .requiredOption('--token <token>', 'One-time pairing token from the admin console Machines page')
    .option('--name <name>', 'Friendly name for this machine')
    .action(async (opts) => {
      process.exitCode = await runConnect(opts);
    });

  program
    .command('install')
    .description('Pair this machine and start the daemon in one command')
    .requiredOption('--server-url <url>', 'Server base URL (e.g. https://open-claude-tag.example.com)')
    .option('--token <token>', 'One-time pairing token from the admin console Machines page')
    .option('--api-key <token>', 'Alias for --token for one-command installers')
    .option('--name <name>', 'Friendly name for this machine')
    .option('--background', 'Start the daemon as a detached background process')
    .action(async (opts) => {
      process.exitCode = await runInstall(opts);
    });

  program
    .command('start')
    .description('Run the daemon in the foreground (connect, heartbeat, execute dispatched tasks)')
    .option('--background', 'Start as a detached background process')
    .action(async (opts) => {
      process.exitCode = await runStart({ background: opts.background === true });
    });

  program
    .command('stop')
    .description('Stop the background daemon started with "start --background"')
    .action(async () => {
      process.exitCode = await runStop();
    });

  program
    .command('status')
    .description('Show the config summary (secret redacted), server reachability, and protocol compatibility')
    .action(async () => {
      process.exitCode = await runStatus();
    });

  program
    .command('doctor')
    .description('Run environment checks: config, server, protocol, runtimes, workspace')
    .action(async () => {
      process.exitCode = await runDoctor();
    });

  return program;
}

/** CLI entry: parse argv and run. */
export async function main(argv = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
