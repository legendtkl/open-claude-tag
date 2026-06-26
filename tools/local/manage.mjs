#!/usr/bin/env node
/**
 * Local process manager for OpenClaudeTag (API + Worker).
 *
 * Uses pm2 for process supervision (auto-restart on crash) and
 * tmux for log visibility.
 *
 * Commands:
 *   start            Start api and worker via pm2, open tmux session
 *   stop             Stop api and worker, close tmux session
 *   restart          Restart api only — worker keeps running
 *   restart --worker Restart both api and worker
 *   status           Print current pm2 status
 *
 * Log files: /tmp/open-claude-tag/primary/{api,worker}.log
 * tmux session: open-claude-tag  (windows: api, worker)
 */

import { spawnSync } from 'child_process';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOG_DIR = '/tmp/open-claude-tag/primary';
const ECOSYSTEM = resolve(REPO_ROOT, 'ecosystem.local.config.cjs');
const PM2 = resolve(REPO_ROOT, 'node_modules/.bin/pm2');
const TMUX_SESSION = 'open-claude-tag';

const SERVICES = {
  api: { pm2Name: 'open-claude-tag-api', tmuxWindow: 'api', healthUrl: 'http://127.0.0.1:3000/health' },
  worker: { pm2Name: 'open-claude-tag-worker', tmuxWindow: 'worker' },
};

// ── Utilities ────────────────────────────────────────────────────────────────

function pm2(args, { silent = false } = {}) {
  return spawnSync(PM2, args, {
    cwd: REPO_ROOT,
    stdio: silent ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
}

function pm2Out(args) {
  return pm2(args, { silent: true }).stdout ?? '';
}

function isPm2Running(pm2Name) {
  try {
    const list = JSON.parse(pm2Out(['jlist']));
    const app = list.find((p) => p.name === pm2Name);
    return app?.pm2_env?.status === 'online';
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // still starting
    }
    await sleep(1000);
  }
  return false;
}

// ── tmux ─────────────────────────────────────────────────────────────────────

function tmux(args) {
  return spawnSync('tmux', args, { stdio: 'pipe', encoding: 'utf8' });
}

function tmuxSessionExists() {
  return tmux(['has-session', '-t', TMUX_SESSION]).status === 0;
}

function tmuxWindowExists(window) {
  return tmux(['select-window', '-t', `${TMUX_SESSION}:${window}`]).status === 0;
}

function setupTmux() {
  // Always rebuild the session cleanly so windows are in a known state
  if (tmuxSessionExists()) {
    tmux(['kill-session', '-t', TMUX_SESSION]);
  }
  tmux(['new-session', '-d', '-s', TMUX_SESSION, '-n', 'api', '-x', '220', '-y', '50']);

  // Give tmux a moment to initialize the session
  spawnSync('sleep', ['0.3']);

  for (const [i, [, { pm2Name, tmuxWindow }]] of Object.entries(SERVICES).entries()) {
    if (i > 0) {
      tmux(['new-window', '-t', TMUX_SESSION, '-n', tmuxWindow]);
    } else {
      // First window was created by new-session; just rename it
      tmux(['rename-window', '-t', `${TMUX_SESSION}:0`, tmuxWindow]);
    }
    // Wrap in a loop so the pane stays alive if pm2 logs exits unexpectedly
    const cmd = `while true; do ${PM2} logs ${pm2Name} --raw; sleep 2; done`;
    tmux(['send-keys', '-t', `${TMUX_SESSION}:${tmuxWindow}`, cmd, 'Enter']);
  }

  tmux(['select-window', '-t', `${TMUX_SESSION}:api`]);
  console.log(`tmux session '${TMUX_SESSION}' ready  (attach: tmux attach -t ${TMUX_SESSION})`);
}

function teardownTmux() {
  if (tmuxSessionExists()) {
    tmux(['kill-session', '-t', TMUX_SESSION]);
    console.log(`tmux session '${TMUX_SESSION}' closed`);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

async function startAll() {
  mkdirSync(LOG_DIR, { recursive: true });

  const apiRunning = isPm2Running(SERVICES.api.pm2Name);
  const workerRunning = isPm2Running(SERVICES.worker.pm2Name);

  if (apiRunning && workerRunning) {
    console.log('api: already running');
    console.log('worker: already running');
    setupTmux();
    return;
  }

  pm2(['start', ECOSYSTEM]);

  console.log('Waiting for API health check...');
  const healthy = await waitForHealth(SERVICES.api.healthUrl);
  if (!healthy) {
    console.error(`api: health check timed out — check logs at ${LOG_DIR}/api.log`);
    process.exit(1);
  }

  console.log('api: ready  →  http://localhost:3000');
  console.log('worker: running');
  setupTmux();
}

// ── Stop ─────────────────────────────────────────────────────────────────────

function stopAll() {
  pm2(['stop', ECOSYSTEM]);
  pm2(['delete', ECOSYSTEM]);
  teardownTmux();
  console.log('api: stopped');
  console.log('worker: stopped');
}

// ── Restart ──────────────────────────────────────────────────────────────────

async function restartServices(withWorker) {
  mkdirSync(LOG_DIR, { recursive: true });

  if (withWorker) {
    pm2(['restart', SERVICES.worker.pm2Name]);
    console.log('worker: restarting');
  } else {
    console.log('worker: kept running');
  }

  pm2(['restart', SERVICES.api.pm2Name]);
  console.log('Waiting for API health check...');
  const healthy = await waitForHealth(SERVICES.api.healthUrl);
  if (!healthy) {
    console.error(`api: health check timed out — check logs at ${LOG_DIR}/api.log`);
    process.exit(1);
  }

  console.log('api: ready  →  http://localhost:3000');
  setupTmux();
}

// ── Status ───────────────────────────────────────────────────────────────────

function printStatus() {
  pm2(['list']);
}

// ── Commands ─────────────────────────────────────────────────────────────────

const [, , cmd, ...args] = process.argv;
const withWorker = args.includes('--worker');

switch (cmd) {
  case 'start':
    await startAll();
    break;

  case 'stop':
    stopAll();
    break;

  case 'restart':
    await restartServices(withWorker);
    break;

  case 'status':
    printStatus();
    break;

  default:
    console.error('Usage: manage.mjs <start|stop|restart|status> [--worker]');
    process.exit(1);
}
