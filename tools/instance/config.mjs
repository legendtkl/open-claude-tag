import path from 'path';
import { existsSync, readFileSync } from 'fs';

const DEFAULT_DATABASE_URL = 'postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag';
const RUNTIME_ROOT = '/tmp/open-claude-tag';
const PID_ROOT = RUNTIME_ROOT;
const ISOLATED_PORT_BASE = 3100;
const ISOLATED_PORT_RANGE = 2000;
const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;
const PRIMARY_REPO_BASENAMES = new Set(['open-claude-tag']);

function hashString(input) {
  let hash = 0;
  for (const char of input) {
    hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function sanitizeInstanceId(rawValue) {
  const sanitized = rawValue
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || 'main';
}

function sanitizeDbIdentifier(rawValue) {
  return (
    rawValue
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'open-claude-tag'
  );
}

function shortenDbIdentifier(identifier) {
  if (identifier.length <= POSTGRES_IDENTIFIER_MAX_LENGTH) {
    return identifier;
  }

  const suffix = hashString(identifier).toString(16).slice(0, 8);
  const head = identifier.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH - suffix.length - 1);
  return `${head}_${suffix}`;
}

export function deriveInstanceId({ cwd = process.cwd(), env = process.env } = {}) {
  const cwdBasename = path.basename(cwd);
  const allowEnvOverride =
    PRIMARY_REPO_BASENAMES.has(cwdBasename) || env.OPEN_TAG_INSTANCE_ROLE === 'isolated';

  if (allowEnvOverride && env.OPEN_TAG_INSTANCE_ID?.trim()) {
    return sanitizeInstanceId(env.OPEN_TAG_INSTANCE_ID);
  }

  return sanitizeInstanceId(cwdBasename);
}

export function deriveInstanceRole({ cwd = process.cwd(), env = process.env } = {}) {
  const cwdBasename = path.basename(cwd);
  const isPrimaryRepo = PRIMARY_REPO_BASENAMES.has(cwdBasename);

  if (env.OPEN_TAG_INSTANCE_ROLE === 'isolated') {
    return 'isolated';
  }
  if (env.OPEN_TAG_INSTANCE_ROLE === 'primary' && isPrimaryRepo) {
    return 'primary';
  }

  return isPrimaryRepo ? 'primary' : 'isolated';
}

export function deriveApiPort(instanceId) {
  return ISOLATED_PORT_BASE + (hashString(instanceId) % ISOLATED_PORT_RANGE);
}

export function deriveApiUrl(port) {
  return `http://127.0.0.1:${port}`;
}

export function derivePidPaths({ instanceRole, instanceId }) {
  if (instanceRole === 'primary') {
    return {
      apiPidPath: path.join(PID_ROOT, 'primary', 'api.pid.json'),
      workerPidPath: path.join(PID_ROOT, 'primary', 'worker.pid.json'),
    };
  }

  return {
    apiPidPath: path.join(PID_ROOT, 'isolated', instanceId, 'api.pid.json'),
    workerPidPath: path.join(PID_ROOT, 'isolated', instanceId, 'worker.pid.json'),
  };
}

export function deriveDatabaseUrl(baseDatabaseUrl, instanceId) {
  const source = new URL(baseDatabaseUrl || DEFAULT_DATABASE_URL);
  const baseName = sanitizeDbIdentifier(source.pathname.replace(/^\//, '') || 'open-claude-tag');
  const instanceName = sanitizeDbIdentifier(instanceId.replace(/-/g, '_'));
  const targetName = shortenDbIdentifier(`${baseName}_${instanceName}`);
  source.pathname = `/${targetName}`;
  return source.toString();
}

export function buildIsolatedInstanceConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const instanceRole = deriveInstanceRole({ cwd, env });
  const instanceId = deriveInstanceId({ cwd, env });
  const port = deriveApiPort(instanceId);
  const databaseUrl = deriveDatabaseUrl(env.DATABASE_URL ?? DEFAULT_DATABASE_URL, instanceId);
  const apiUrl = deriveApiUrl(port);
  const { apiPidPath, workerPidPath } = derivePidPaths({ instanceRole, instanceId });

  return {
    instanceRole,
    instanceId,
    port,
    apiUrl,
    databaseUrl,
    apiPidPath,
    workerPidPath,
    cwd,
  };
}

function readDotenvValue(cwd, key) {
  const envPath = path.join(cwd, '.env');
  if (!existsSync(envPath)) return undefined;
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return undefined;
  }
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm');
  const match = text.match(re);
  if (!match) return undefined;
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

export function buildIsolatedEnv({ cwd = process.cwd(), env = process.env } = {}) {
  const normalizedEnv = {
    ...env,
    OPEN_TAG_INSTANCE_ROLE: 'isolated',
  };
  if (!PRIMARY_REPO_BASENAMES.has(path.basename(cwd))) {
    delete normalizedEnv.OPEN_TAG_INSTANCE_ID;
  }

  const config = buildIsolatedInstanceConfig({
    cwd,
    env: normalizedEnv,
  });

  return {
    ...env,
    OPEN_TAG_INSTANCE_ROLE: 'isolated',
    OPEN_TAG_INSTANCE_ID: config.instanceId,
    API_PORT: String(config.port),
    PORT: String(config.port),
    // Daemon gateway port must be instance-unique too: the API port range is
    // ISOLATED_PORT_BASE..+ISOLATED_PORT_RANGE (3100..5100), so +2000 maps the
    // gateway into 5100..7100 with no overlap against other isolated APIs.
    DAEMON_GATEWAY_PORT: String(config.port + 2000),
    API_URL: config.apiUrl,
    DATABASE_URL: config.databaseUrl,
    OPEN_TAG_API_PID_PATH: config.apiPidPath,
    OPEN_TAG_WORKER_PID_PATH: config.workerPidPath,
    // Isolated verification must fail closed even when a personal `.env` enables
    // open-access mode for local demos. `tsx --env-file` preserves explicit env
    // values, so this also prevents the repo `.env` from reopening owner gates.
    OPEN_ACCESS: 'false',
    OPEN_TAG_FEISHU_ACCESS:
      (env.OPEN_TAG_FEISHU_ACCESS ?? readDotenvValue(cwd, 'OPEN_TAG_FEISHU_ACCESS')) ===
      'enabled'
        ? 'enabled'
        : 'disabled',
  };
}
