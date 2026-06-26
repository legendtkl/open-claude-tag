#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const DEFAULT_PROBES = [
  { name: 'api', url: 'http://127.0.0.1:3000/health' },
  { name: 'console', url: 'http://127.0.0.1:8080/admin/auth/config' },
];

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1_000;

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return null;
  const index = trimmed.indexOf('=');
  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (quoted) {
    value = value.slice(1, -1);
  } else {
    const commentIndex = value.indexOf(' #');
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
  }

  return [key, value];
}

export function loadEnvFile(filePath, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (!filePath || !existsSync(filePath)) return env;

  const contents = readFileSync(filePath, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

function defaultStateFile(env) {
  const home = env.HOME || os.homedir();
  return resolve(home, '.open-claude-tag-health-alert-state.json');
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseProbeList(value) {
  if (!value?.trim()) return DEFAULT_PROBES;

  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error('OPEN_TAG_HEALTH_PROBES JSON must be an array');
    }
    return parsed.map((probe) => {
      if (!probe || typeof probe.name !== 'string' || typeof probe.url !== 'string') {
        throw new Error('Each JSON probe must have string name and url fields');
      }
      return { name: probe.name, url: probe.url };
    });
  }

  return trimmed.split(',').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid probe entry "${entry}". Use name=url`);
    }
    const name = entry.slice(0, separator).trim();
    const url = entry.slice(separator + 1).trim();
    if (!name || !url) {
      throw new Error(`Invalid probe entry "${entry}". Use name=url`);
    }
    return { name, url };
  });
}

function loadState(filePath) {
  if (!existsSync(filePath)) {
    return { status: 'unknown' };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { status: 'unknown' };
  } catch {
    return { status: 'unknown' };
  }
}

function saveState(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function fetchWithTimeout(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkProbe(probe, options) {
  const startedAt = options.now();

  try {
    const response = await fetchWithTimeout(probe.url, options.timeoutMs, options.fetchImpl);
    const elapsedMs = options.now() - startedAt;
    let body = null;

    const contentType = response.headers?.get?.('content-type') ?? '';
    if (contentType.includes('application/json')) {
      body = await response.json().catch(() => null);
    }

    if (!response.ok) {
      return {
        ...probe,
        ok: false,
        elapsedMs,
        reason: `HTTP ${response.status}`,
      };
    }

    if (body && typeof body === 'object' && 'status' in body && body.status !== 'ok') {
      return {
        ...probe,
        ok: false,
        elapsedMs,
        reason: `health status ${body.status}`,
      };
    }

    return { ...probe, ok: true, elapsedMs };
  } catch (error) {
    const elapsedMs = options.now() - startedAt;
    const reason = error instanceof Error ? error.message : String(error);
    return { ...probe, ok: false, elapsedMs, reason };
  }
}

function resolveAlertTarget(env) {
  const receiveId = env.OPEN_TAG_HEALTH_ALERT_RECEIVE_ID || env.ALERT_CHAT_ID || '';
  const receiveIdType =
    env.OPEN_TAG_HEALTH_ALERT_RECEIVE_ID_TYPE || (env.ALERT_CHAT_ID ? 'chat_id' : 'email');
  return { receiveId, receiveIdType };
}

async function getTenantAccessToken(env, fetchImpl) {
  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required for alerts');
  }

  const baseUrl = env.FEISHU_OPEN_BASE_URL || 'https://open.feishu.cn/open-apis';
  const response = await fetchImpl(`${baseUrl}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`tenant_access_token failed: code ${data.code ?? response.status} ${data.msg ?? ''}`.trim());
  }
  return data.tenant_access_token;
}

async function sendFeishuText(env, text, fetchImpl) {
  const { receiveId, receiveIdType } = resolveAlertTarget(env);
  if (!receiveId) {
    throw new Error('OPEN_TAG_HEALTH_ALERT_RECEIVE_ID or ALERT_CHAT_ID is required');
  }

  if (env.OPEN_TAG_HEALTH_ALERT_DRY_RUN === 'true') {
    return { dryRun: true, receiveIdType, receiveId, text };
  }

  const token = await getTenantAccessToken(env, fetchImpl);
  const baseUrl = env.FEISHU_OPEN_BASE_URL || 'https://open.feishu.cn/open-apis';
  const response = await fetchImpl(
    `${baseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    },
  );
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`send alert failed: code ${data.code ?? response.status} ${data.msg ?? ''}`.trim());
  }
  return data;
}

function formatDownAlert(input) {
  const lines = [
    'OpenClaudeTag service health alert',
    `Instance: ${input.instanceId}`,
    `Host: ${input.hostname}`,
    `Detected at: ${input.detectedAt}`,
    'Down probes:',
  ];
  for (const failure of input.failures) {
    lines.push(`- ${failure.name}: ${failure.url} (${failure.reason || 'failed'})`);
  }
  return lines.join('\n');
}

function formatRecoveryAlert(input) {
  return [
    'OpenClaudeTag service health recovered',
    `Instance: ${input.instanceId}`,
    `Host: ${input.hostname}`,
    `Recovered at: ${input.detectedAt}`,
  ].join('\n');
}

export async function runHealthAlert(input = {}) {
  const baseEnv = input.env ?? process.env;
  const envFile = input.envFile ?? baseEnv.OPEN_TAG_ENV_FILE ?? resolve(process.cwd(), '.env');
  const env = loadEnvFile(envFile, baseEnv);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = input.now ?? (() => Date.now());
  const probes = input.probes ?? parseProbeList(env.OPEN_TAG_HEALTH_PROBES);
  const timeoutMs = parseInteger(env.OPEN_TAG_HEALTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const cooldownMs = parseInteger(env.OPEN_TAG_HEALTH_ALERT_COOLDOWN_MS, DEFAULT_COOLDOWN_MS);
  const stateFile = input.stateFile ?? env.OPEN_TAG_HEALTH_STATE_FILE ?? defaultStateFile(env);
  const state = loadState(stateFile);
  const detectedAt = new Date(now()).toISOString();
  const results = await Promise.all(
    probes.map((probe) => checkProbe(probe, { timeoutMs, fetchImpl, now })),
  );
  const failures = results.filter((result) => !result.ok);
  const hostname = env.OPEN_TAG_HEALTH_HOSTNAME || os.hostname();
  const instanceId = env.OPEN_TAG_INSTANCE_ID || 'primary';
  const previousStatus = state.status ?? 'unknown';
  const lastDownAlertAt = Number.isFinite(state.lastDownAlertAt) ? state.lastDownAlertAt : 0;
  const shouldAlertDown =
    failures.length > 0 &&
    (previousStatus !== 'down' || now() - lastDownAlertAt >= cooldownMs);
  const shouldAlertRecovery =
    failures.length === 0 &&
    previousStatus === 'down' &&
    env.OPEN_TAG_HEALTH_RECOVERY_ALERT !== 'false';

  let alert = null;
  if (shouldAlertDown) {
    const text = formatDownAlert({ instanceId, hostname, detectedAt, failures });
    alert = await sendFeishuText(env, text, fetchImpl);
  } else if (shouldAlertRecovery) {
    const text = formatRecoveryAlert({ instanceId, hostname, detectedAt });
    alert = await sendFeishuText(env, text, fetchImpl);
  }

  const nextState =
    failures.length > 0
      ? {
          status: 'down',
          downSince: previousStatus === 'down' ? state.downSince : detectedAt,
          lastDownAlertAt: shouldAlertDown ? now() : lastDownAlertAt,
          lastFailures: failures.map(({ name, url, reason }) => ({ name, url, reason })),
        }
      : {
          status: 'healthy',
          lastHealthyAt: detectedAt,
          lastRecoveryAlertAt: shouldAlertRecovery ? now() : state.lastRecoveryAlertAt,
        };
  saveState(stateFile, nextState);

  return { status: nextState.status, results, failures, alert, state: nextState };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const env = dryRun ? { ...process.env, OPEN_TAG_HEALTH_ALERT_DRY_RUN: 'true' } : process.env;
  const result = await runHealthAlert({ env });
  const failed = result.failures.map((failure) => `${failure.name}=${failure.reason}`).join(', ');
  const suffix = failed ? ` (${failed})` : '';
  console.log(`health ${result.status}${suffix}`);
  if (result.alert?.dryRun) {
    console.log(`dry-run alert to ${result.alert.receiveIdType}:${result.alert.receiveId}`);
    console.log(result.alert.text);
  }

  if (env.OPEN_TAG_HEALTH_EXIT_NONZERO_ON_DOWN === 'true' && result.status === 'down') {
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
