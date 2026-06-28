#!/usr/bin/env node
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import process from 'process';

const storageRequire = createRequire(
  new URL('../../packages/storage/package.json', import.meta.url),
);
const postgres = storageRequire('postgres');

const DEFAULT_API_URL = 'http://127.0.0.1:3820';
const DEFAULT_TIMEOUT_MS = 180_000;
const FEISHU_OPEN_BASE_URL = 'https://open.feishu.cn/open-apis';

const REQUIRED_MESSAGE_CAPABILITIES = [
  'receive-p2p-message',
  'receive-group-at-message',
  'send-message-as-bot',
  'update-message-card',
  'message-reactions',
  'read-message',
  'read-chat',
];

function usage() {
  return `Usage: pnpm lark:personal-two-bot-e2e [--api-url URL] [--from-app-id cli_x] [--to-app-id cli_y] [--execute] [--timeout-ms N]

Default mode is a no-side-effect readiness check. --execute creates a private
Feishu test chat and sends a visible @bot test message.`;
}

function parseArgs(argv) {
  const args = {
    apiUrl: process.env.API_URL || DEFAULT_API_URL,
    fromAppId: '',
    toAppId: '',
    execute: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--api-url':
        args.apiUrl = requireArg(argv, ++index, arg);
        break;
      case '--from-app-id':
        args.fromAppId = requireArg(argv, ++index, arg);
        break;
      case '--to-app-id':
        args.toAppId = requireArg(argv, ++index, arg);
        break;
      case '--execute':
        args.execute = true;
        break;
      case '--timeout-ms':
        args.timeoutMs = Number.parseInt(requireArg(argv, ++index, arg), 10);
        if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
          throw new Error('--timeout-ms must be a positive integer');
        }
        break;
      case '--help':
      case '-h':
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  args.apiUrl = args.apiUrl.replace(/\/+$/, '');
  return args;
}

function requireArg(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseDotenvValue(rawValue) {
  let value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function loadDotenv(cwd) {
  const envPath = path.join(cwd, '.env');
  if (!existsSync(envPath)) return {};
  const values = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = parseDotenvValue(match[2]);
  }
  return values;
}

const dotenv = loadDotenv(process.cwd());

function readConfig(key) {
  return process.env[key] ?? dotenv[key] ?? '';
}

function maskAppId(appId) {
  if (!appId) return '';
  if (appId.length <= 10) return `${appId.slice(0, 3)}...`;
  return `${appId.slice(0, 8)}...${appId.slice(-4)}`;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function fetchApi(apiUrl, pathName, init = {}) {
  return fetchJson(`${apiUrl}${pathName}`, init);
}

function selectBots(apps, fromAppId, toAppId) {
  const enabled = apps.filter((app) => app.status === 'enabled');
  const from = fromAppId
    ? enabled.find((app) => app.appId === fromAppId || app.id === fromAppId)
    : enabled.find((app) => /OpenClaudeTag E2E Bot A/.test(app.botName ?? '')) ??
      enabled.find((app) => /OpenClaudeTag E2E Bot/.test(app.botName ?? ''));
  const to = toAppId
    ? enabled.find((app) => app.appId === toAppId || app.id === toAppId)
    : enabled.find(
        (app) =>
          app.id !== from?.id &&
          (/OpenClaudeTag E2E Bot B/.test(app.botName ?? '') ||
            /OpenClaudeTag E2E Reviewer/.test(app.binding?.agentDisplayName ?? '')),
      ) ?? enabled.find((app) => app.id !== from?.id && /OpenClaudeTag E2E Bot/.test(app.botName ?? ''));

  if (!from || !to) {
    throw new Error(
      'Could not infer two enabled E2E bots. Pass --from-app-id and --to-app-id explicitly.',
    );
  }
  if (from.id === to.id || from.appId === to.appId) {
    throw new Error('Sender and target bots must be distinct.');
  }
  return { from, to };
}

function summarizeBot(app, healthApps) {
  const health = healthApps.find((item) => item.id === app.id || item.appId === app.appId) ?? {};
  return {
    id: app.id,
    appId: app.appId,
    maskedAppId: maskAppId(app.appId),
    botName: app.botName,
    botOpenId: app.botOpenId,
    eventMode: app.eventMode,
    status: app.status,
    binding: app.binding
      ? {
          agentId: app.binding.agentId,
          agentHandle: app.binding.agentHandle,
          status: app.binding.status,
        }
      : null,
    healthStatus: health.status ?? null,
    wsStatus: health.wsStatus ?? null,
    hasActiveBotBinding: health.hasActiveBotBinding ?? Boolean(app.binding),
  };
}

async function checkPermissions(apiUrl, app) {
  const result = await fetchApi(apiUrl, `/admin/feishu-apps/${encodeURIComponent(app.id)}/permission-check`, {
    method: 'POST',
  });
  const byId = new Map((result.capabilities ?? []).map((capability) => [capability.id, capability]));
  const missingMessageCapabilities = REQUIRED_MESSAGE_CAPABILITIES.filter(
    (id) => byId.get(id)?.status !== 'ok',
  );
  return {
    status: result.status,
    missingRequiredCapabilities: result.missingRequiredCapabilities ?? [],
    optionalMissingCapabilities: result.optionalMissingCapabilities ?? [],
    missingMessageCapabilities,
  };
}

async function readiness(args) {
  const [health, apps] = await Promise.all([
    fetchApi(args.apiUrl, '/health'),
    fetchApi(args.apiUrl, '/admin/feishu-apps'),
  ]);
  const { from, to } = selectBots(apps, args.fromAppId, args.toAppId);
  const healthApps = health.feishu?.apps ?? [];
  const [fromPermission, toPermission] = await Promise.all([
    checkPermissions(args.apiUrl, from),
    checkPermissions(args.apiUrl, to),
  ]);
  const bots = {
    from: summarizeBot(from, healthApps),
    to: summarizeBot(to, healthApps),
  };
  const checks = [
    { name: 'api-health', ok: health.status === 'ok' },
    { name: 'feishu-live', ok: health.feishu?.access === 'live' && health.feishu?.websocket === 'live' },
    { name: 'worker-health', ok: health.worker?.status === 'healthy' },
    { name: 'from-bot-live', ok: bots.from.wsStatus === 'live' && bots.from.hasActiveBotBinding },
    { name: 'to-bot-live', ok: bots.to.wsStatus === 'live' && bots.to.hasActiveBotBinding },
    { name: 'from-message-permissions', ok: fromPermission.missingMessageCapabilities.length === 0 },
    { name: 'to-message-permissions', ok: toPermission.missingMessageCapabilities.length === 0 },
  ];
  return {
    apiUrl: args.apiUrl,
    execute: args.execute,
    status: checks.every((check) => check.ok) ? 'ready' : 'not_ready',
    checks,
    bots,
    permissionChecks: {
      from: fromPermission,
      to: toPermission,
    },
    selectedApps: { from, to },
  };
}

async function resolveAppSecret(app) {
  const envSecret = resolveEnvSecret(app.appSecretRef);
  if (envSecret) return envSecret;

  const databaseUrl = readConfig('DATABASE_URL').trim();
  if (!databaseUrl) {
    throw new Error(
      `DATABASE_URL is required to read stored secret for ${app.botName ?? app.appId}.`,
    );
  }
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    const [row] = await sql`
      select app_secret, app_secret_ref
      from feishu_apps
      where id = ${app.id}
      limit 1
    `;
    if (!row) throw new Error(`Feishu app not found in database: ${app.id}`);
    const dbEnvSecret = resolveEnvSecret(row.app_secret_ref);
    if (dbEnvSecret) return dbEnvSecret;
    const storedSecret = typeof row.app_secret === 'string' ? row.app_secret.trim() : '';
    if (storedSecret) return storedSecret;
    throw new Error(`No stored or environment secret is available for ${app.botName ?? app.appId}.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function resolveEnvSecret(secretRef) {
  if (!secretRef || secretRef === 'stored') return '';
  const envName = String(secretRef).replace(/^env:/, '');
  return readConfig(envName).trim();
}

async function feishuRequest(token, method, pathName, { query = {}, body } = {}) {
  const url = new URL(`${FEISHU_OPEN_BASE_URL}${pathName}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const result = await fetchJson(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (result && typeof result === 'object' && result.code !== undefined && result.code !== 0) {
    throw new Error(`Feishu ${method} ${pathName} failed: code ${result.code} ${result.msg ?? ''}`);
  }
  return result;
}

async function getTenantToken(app) {
  const appSecret = await resolveAppSecret(app);
  const result = await fetchJson(`${FEISHU_OPEN_BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    body: JSON.stringify({ app_id: app.appId, app_secret: appSecret }),
  });
  if (result.code !== undefined && result.code !== 0) {
    throw new Error(`Feishu tenant token failed: code ${result.code} ${result.msg ?? ''}`);
  }
  if (!result.tenant_access_token) throw new Error('Feishu tenant token response was empty.');
  return result.tenant_access_token;
}

async function createChat(token, targetBot, timestamp) {
  const result = await feishuRequest(token, 'POST', '/im/v1/chats', {
    body: {
      name: `OpenClaudeTag E2E ${timestamp}`,
      chat_mode: 'group',
      chat_type: 'private',
      bot_id_list: [targetBot.appId],
    },
  });
  const chatId = result.data?.chat_id ?? result.data?.chat?.chat_id ?? '';
  if (!chatId) throw new Error(`Feishu create chat did not return chat_id: ${JSON.stringify(result)}`);
  return chatId;
}

async function sendTriggerMessage(token, chatId, targetBot, marker) {
  const text = `<at user_id="${targetBot.botOpenId}">${targetBot.botName ?? targetBot.appId}</at> ${marker} Please reply with this exact token and mention OpenClaudeTag.`;
  const result = await feishuRequest(token, 'POST', '/im/v1/messages', {
    query: { receive_id_type: 'chat_id' },
    body: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
      uuid: randomUUID(),
    },
  });
  const messageId = result.data?.message_id ?? '';
  if (!messageId) {
    throw new Error(`Feishu send message did not return message_id: ${JSON.stringify(result)}`);
  }
  return { messageId, text };
}

async function pollTask(apiUrl, chatId, timeoutMs) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await fetchApi(apiUrl, '/debug/latest-task', {
      method: 'POST',
      body: JSON.stringify({ chatId }),
    });
    if (latest.task?.status === 'completed' || latest.task?.status === 'failed') {
      return latest.task;
    }
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for task completion. Latest: ${JSON.stringify(latest)}`);
}

async function getMessage(token, messageId) {
  if (!messageId) return null;
  const result = await feishuRequest(token, 'GET', `/im/v1/messages/${encodeURIComponent(messageId)}`, {
    query: {
      user_id_type: 'open_id',
      card_msg_content_type: 'user_card_content',
    },
  });
  const items = result.data?.items ?? result.data?.messages ?? [];
  return items.find((item) => item.message_id === messageId) ?? items[0] ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeE2e(args, ready) {
  if (ready.status !== 'ready') {
    throw new Error(`Readiness failed; refusing to execute. Checks: ${JSON.stringify(ready.checks)}`);
  }
  const { from, to } = ready.selectedApps;
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const marker = `E2E_TOKEN_${timestamp}_${randomUUID().slice(0, 8)}`;
  const fromToken = await getTenantToken(from);
  const chatId = await createChat(fromToken, to, timestamp);
  const trigger = await sendTriggerMessage(fromToken, chatId, to, marker);
  const task = await pollTask(args.apiUrl, chatId, args.timeoutMs);
  let replyMessage = null;
  let replyReadError = null;
  if (task.feedbackMessageId) {
    try {
      replyMessage = await getMessage(fromToken, task.feedbackMessageId);
    } catch (error) {
      replyReadError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    marker,
    chatId,
    triggerMessageId: trigger.messageId,
    triggerText: trigger.text,
    task,
    replyMessage,
    replyReadError,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ready = await readiness(args);
  const safeReady = {
    ...ready,
    selectedApps: undefined,
  };

  if (!args.execute) {
    process.stdout.write(`${JSON.stringify(safeReady, null, 2)}\n`);
    process.stdout.write('No Feishu message was sent. Re-run with --execute to perform the visible E2E.\n');
    process.exit(ready.status === 'ready' ? 0 : 1);
  }

  const evidence = await executeE2e(args, ready);
  process.stdout.write(
    `${JSON.stringify(
      {
        ...safeReady,
        evidence,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
