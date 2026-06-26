import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '@open-tag/storage';
import { feishuApps } from '@open-tag/storage';
import { FeishuClient } from '@open-tag/feishu-adapter';
import type { TaskFeishuClientResolver } from './agent-runtime.js';

export interface WorkerFeishuClientRegistryOptions {
  db: Database;
  disabled: boolean;
  primaryAppId: string;
  primaryAppSecret: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  createClient?: (appId: string, appSecret: string) => FeishuClient;
  refreshIntervalMs?: number;
}

export interface WorkerFeishuClientRegistry extends TaskFeishuClientResolver {
  primaryClient: FeishuClient | null;
  registeredAppIds(): string[];
  reload(): Promise<void>;
}

export function resolveSecretRef(ref: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (ref === 'stored') return null;
  const key = ref.startsWith('env:') ? ref.slice('env:'.length) : ref;
  return env[key] ?? null;
}

export async function createWorkerFeishuClientRegistry(
  options: WorkerFeishuClientRegistryOptions,
): Promise<WorkerFeishuClientRegistry> {
  const clientsByFeishuAppId = new Map<string, FeishuClient>();
  const createClient =
    options.createClient ?? ((appId, appSecret) => new FeishuClient({ appId, appSecret }));

  if (options.disabled) {
    return {
      get primaryClient() {
        return null;
      },
      registeredAppIds: () => [],
      getClient: async () => null,
      reload: async () => undefined,
    };
  }

  let primaryClient: FeishuClient | null = null;
  let lastRefreshAt = 0;
  let refreshPromise: Promise<void> | null = null;
  const refreshIntervalMs = options.refreshIntervalMs ?? 5_000;

  async function reload(): Promise<void> {
    if (refreshPromise) {
      await refreshPromise;
      return;
    }

    refreshPromise = (async () => {
      const rows = await options.db
        .select()
        .from(feishuApps)
        .where(eq(feishuApps.status, 'enabled'));
      const nextClients = new Map<string, FeishuClient>();
      let nextPrimaryClient: FeishuClient | null = null;

      if (rows.length > 0) {
        for (const row of rows) {
          const appSecret =
            resolveSecretRef(row.appSecretRef, options.env) ??
            row.appSecret ??
            (row.appId === options.primaryAppId ? options.primaryAppSecret : null);

          if (!appSecret) {
            options.logger?.warn(
              { feishuAppId: row.id, appId: row.appId, appSecretRef: row.appSecretRef },
              'Skipping Feishu app client because secret is unavailable',
            );
            continue;
          }

          const client = createClient(row.appId, appSecret);
          nextClients.set(row.id, client);

          if (row.appId === options.primaryAppId || !nextPrimaryClient) {
            nextPrimaryClient = client;
          }
        }
      } else if (options.primaryAppId && options.primaryAppSecret) {
        nextPrimaryClient = createClient(options.primaryAppId, options.primaryAppSecret);
      }

      if (!nextPrimaryClient && options.primaryAppId && options.primaryAppSecret) {
        nextPrimaryClient = createClient(options.primaryAppId, options.primaryAppSecret);
      }

      if (!nextPrimaryClient) {
        throw new Error(
          'FEISHU_APP_ID and FEISHU_APP_SECRET are required. Worker cannot send task feedback without Feishu.',
        );
      }

      clientsByFeishuAppId.clear();
      for (const [id, client] of nextClients) {
        clientsByFeishuAppId.set(id, client);
      }
      primaryClient = nextPrimaryClient;
      lastRefreshAt = Date.now();
    })().finally(() => {
      refreshPromise = null;
    });

    await refreshPromise;
  }

  async function ensureFresh(force = false): Promise<void> {
    const isStale = Date.now() - lastRefreshAt >= refreshIntervalMs;
    if (!force && !isStale) return;
    try {
      await reload();
    } catch (err) {
      if (!primaryClient) throw err;
      options.logger?.warn({ err }, 'Keeping previous Feishu client registry after reload failed');
    }
  }

  await reload();

  return {
    get primaryClient() {
      return primaryClient;
    },
    registeredAppIds: () => [...clientsByFeishuAppId.keys()],
    reload,
    getClient: async (feishuAppId) => {
      await ensureFresh();
      if (!feishuAppId) return primaryClient;
      const client = clientsByFeishuAppId.get(feishuAppId);
      if (client) return client;
      await ensureFresh(true);
      return clientsByFeishuAppId.get(feishuAppId) ?? null;
    },
  };
}
