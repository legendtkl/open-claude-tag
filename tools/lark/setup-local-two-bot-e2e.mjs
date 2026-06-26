#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import process from 'process';

const storageRequire = createRequire(
  new URL('../../packages/storage/package.json', import.meta.url),
);
const postgres = storageRequire('postgres');

const DEFAULT_BOTS = [
  {
    label: 'bot1',
    appIdVar: 'FEISHU_LOCAL_E2E_BOT1_APP_ID',
    secretVar: 'FEISHU_LOCAL_E2E_BOT1_APP_SECRET',
    handleVar: 'FEISHU_LOCAL_E2E_BOT1_AGENT_HANDLE',
    displayNameVar: 'FEISHU_LOCAL_E2E_BOT1_AGENT_DISPLAY_NAME',
    defaultHandle: 'codex-mac',
    defaultDisplayName: 'OpenClaudeTagBot1',
  },
  {
    label: 'bot2',
    appIdVar: 'FEISHU_LOCAL_E2E_BOT2_APP_ID',
    secretVar: 'FEISHU_LOCAL_E2E_BOT2_APP_SECRET',
    handleVar: 'FEISHU_LOCAL_E2E_BOT2_AGENT_HANDLE',
    displayNameVar: 'FEISHU_LOCAL_E2E_BOT2_AGENT_DISPLAY_NAME',
    defaultHandle: 'reviewer',
    defaultDisplayName: 'OpenClaudeTagBot2',
  },
];

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
  if (!existsSync(envPath)) {
    return {};
  }

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

function requireConfig(key) {
  const value = readConfig(key).trim();
  if (!value) {
    throw new Error(
      `Missing ${key}. Put it in the local .env or export it before running this setup.`,
    );
  }
  return value;
}

function optionalConfig(key, fallback) {
  const value = readConfig(key).trim();
  return value || fallback;
}

function sanitizeHandle(value, key) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${key} must match [A-Za-z0-9_-]+. Received: ${value}`);
  }
  return value;
}

function maskAppId(appId) {
  if (appId.length <= 10) {
    return `${appId.slice(0, 3)}...`;
  }
  return `${appId.slice(0, 8)}...${appId.slice(-4)}`;
}

function requireIsolatedInstance() {
  if (process.env.OPEN_TAG_INSTANCE_ROLE === 'isolated') {
    return;
  }
  if (process.env.ALLOW_PRIMARY_FEISHU_LOCAL_E2E === 'true') {
    return;
  }
  throw new Error(
    'Refusing to seed local Feishu E2E bots outside an isolated instance. Run through "pnpm lark:setup-two-bot-e2e", or set ALLOW_PRIMARY_FEISHU_LOCAL_E2E=true deliberately.',
  );
}

function buildBotConfig(definition) {
  const appId = requireConfig(definition.appIdVar);
  requireConfig(definition.secretVar);
  return {
    ...definition,
    appId,
    secretRef: `env:${definition.secretVar}`,
    handle: sanitizeHandle(
      optionalConfig(definition.handleVar, definition.defaultHandle),
      definition.handleVar,
    ),
    displayName: optionalConfig(definition.displayNameVar, definition.defaultDisplayName),
  };
}

async function upsertBot(tx, bot) {
  const profileName = `local-e2e-${bot.handle}`;
  const [profile] = await tx`
    insert into agent_profiles (
      name,
      display_name,
      description,
      source_type,
      status,
      updated_at
    )
    values (
      ${profileName},
      ${bot.displayName},
      ${`Local Feishu two-bot E2E profile for ${bot.label}.`},
      'local-e2e',
      'active',
      now()
    )
    on conflict (name) do update set
      display_name = excluded.display_name,
      description = excluded.description,
      source_type = excluded.source_type,
      status = excluded.status,
      updated_at = now()
    returning id
  `;

  const [agent] = await tx`
    insert into agents (
      tenant_key,
      scope_type,
      scope_id,
      handle,
      display_name,
      description,
      profile_id,
      visibility,
      runtime_env,
      access_policy,
      status,
      updated_at
    )
    values (
      'default',
      'system',
      'local-e2e',
      ${bot.handle},
      ${bot.displayName},
      ${`Local Feishu two-bot E2E agent for ${bot.label}.`},
      ${profile.id},
      'public',
      '{}'::jsonb,
      '{}'::jsonb,
      'active',
      now()
    )
    on conflict (tenant_key, scope_type, scope_id, handle)
      where platform_owner_id is null
    do update set
      display_name = excluded.display_name,
      description = excluded.description,
      profile_id = excluded.profile_id,
      visibility = excluded.visibility,
      status = excluded.status,
      updated_at = now()
    returning id
  `;

  const [app] = await tx`
    insert into feishu_apps (
      tenant_key,
      app_id,
      app_secret_ref,
      app_secret,
      bot_name,
      event_mode,
      status,
      updated_at
    )
    values (
      'default',
      ${bot.appId},
      ${bot.secretRef},
      null,
      ${bot.displayName},
      'websocket',
      'enabled',
      now()
    )
    on conflict (app_id) do update set
      tenant_key = excluded.tenant_key,
      app_secret_ref = excluded.app_secret_ref,
      app_secret = null,
      bot_name = excluded.bot_name,
      event_mode = excluded.event_mode,
      status = excluded.status,
      updated_at = now()
    returning id
  `;

  await tx`
    update agent_bot_bindings
    set status = 'inactive', updated_at = now()
    where status = 'active'
      and (agent_id = ${agent.id} or feishu_app_id = ${app.id})
  `;

  const [existingBinding] = await tx`
    select id
    from agent_bot_bindings
    where agent_id = ${agent.id}
      and feishu_app_id = ${app.id}
    order by created_at desc
    limit 1
  `;

  const [binding] = existingBinding
    ? await tx`
        update agent_bot_bindings
        set bot_open_id = null, status = 'active', updated_at = now()
        where id = ${existingBinding.id}
        returning id
      `
    : await tx`
        insert into agent_bot_bindings (
          agent_id,
          feishu_app_id,
          bot_open_id,
          status,
          updated_at
        )
        values (
          ${agent.id},
          ${app.id},
          null,
          'active',
          now()
        )
        returning id
      `;

  return {
    label: bot.label,
    appId: maskAppId(bot.appId),
    agentHandle: bot.handle,
    agentId: agent.id,
    feishuAppId: app.id,
    bindingId: binding.id,
  };
}

async function main() {
  requireIsolatedInstance();
  const databaseUrl = requireConfig('DATABASE_URL');
  const bots = DEFAULT_BOTS.map(buildBotConfig);

  if (new Set(bots.map((bot) => bot.appId)).size !== bots.length) {
    throw new Error('Bot app IDs must be distinct.');
  }
  if (new Set(bots.map((bot) => bot.handle)).size !== bots.length) {
    throw new Error('Agent handles must be distinct.');
  }

  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    const results = await sql.begin(async (tx) => {
      const rows = [];
      for (const bot of bots) {
        rows.push(await upsertBot(tx, bot));
      }
      return rows;
    });

    process.stdout.write('Local Feishu two-bot E2E bootstrap complete.\n');
    process.stdout.write(
      `${JSON.stringify(
        {
          instanceId: process.env.OPEN_TAG_INSTANCE_ID ?? '<unknown>',
          instanceRole: process.env.OPEN_TAG_INSTANCE_ROLE ?? '<unknown>',
          bots: results,
          next: [
            'Start API with: OPEN_TAG_FEISHU_ACCESS=enabled pnpm dev:api:isolated',
            'Start Worker with: OPEN_TAG_FEISHU_ACCESS=enabled pnpm dev:worker:isolated',
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
