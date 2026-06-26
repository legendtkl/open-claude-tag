import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '@open-tag/storage';
import { agentBotBindings, feishuApps } from '@open-tag/storage';
import { FeishuClient } from '@open-tag/feishu-adapter';
import { errorMessage } from '@open-tag/core-types';

export type FeishuAppHealthStatus = 'healthy' | 'unhealthy' | 'disabled';
export type FeishuAppWsStatus = 'disabled' | 'starting' | 'live' | 'unhealthy';
export type FeishuAppEventMode = 'websocket' | 'webhook';

export interface FeishuAppRuntimeContext {
  id: string;
  tenantKey: string;
  appId: string;
  appSecretRef: string;
  appSecret: string;
  client: FeishuClient;
  botOpenId: string;
  botName?: string;
  eventMode: FeishuAppEventMode;
  status: FeishuAppHealthStatus;
  wsStatus: FeishuAppWsStatus;
  error?: string;
  isPrimary: boolean;
  persisted: boolean;
  hasActiveBotBinding: boolean;
}

export interface FeishuAppHealthSnapshot {
  id: string;
  tenantKey: string;
  appId: string;
  botOpenId?: string;
  botName?: string;
  eventMode: FeishuAppEventMode;
  status: FeishuAppHealthStatus;
  wsStatus: FeishuAppWsStatus;
  error?: string;
  isPrimary: boolean;
  hasActiveBotBinding: boolean;
}

export interface FetchBotInfoInput {
  appId: string;
  appSecret: string;
}

export interface FetchBotInfoResult {
  openId: string;
  name?: string;
}

export interface MultiFeishuAppRuntimeOptions {
  db: Database;
  disabled: boolean;
  primaryAppId: string;
  primaryAppSecret: string;
  primaryEventMode?: FeishuAppEventMode;
  disabledBotOpenId: string;
  createLoopbackClient: () => FeishuClient;
  createClient?: (appId: string, appSecret: string) => FeishuClient;
  applyClientDebugOverrides?: (client: FeishuClient) => void;
  fetchBotInfo?: (input: FetchBotInfoInput) => Promise<FetchBotInfoResult>;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

interface LoadedFeishuAppRegistration {
  id: string;
  tenantKey: string;
  appId: string;
  appSecretRef: string;
  appSecret: string | null;
  botOpenId: string | null;
  botName: string | null;
  eventMode: FeishuAppEventMode;
  persisted: boolean;
  hasActiveBotBinding: boolean;
}

function normalizeEventMode(value: unknown): FeishuAppEventMode {
  return value === 'webhook' ? 'webhook' : 'websocket';
}

export function resolveSecretRef(ref: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (ref === 'stored') return null;
  const key = ref.startsWith('env:') ? ref.slice('env:'.length) : ref;
  return env[key] ?? null;
}

async function fetchBotInfoFromFeishu(
  input: FetchBotInfoInput,
): Promise<FetchBotInfoResult> {
  const baseUrl = process.env.FEISHU_BASE_URL ?? 'https://open.feishu.cn';
  const tokenResp = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: input.appId,
      app_secret: input.appSecret,
    }),
  });
  const tokenData = (await tokenResp.json()) as { tenant_access_token?: string };
  const token = tokenData.tenant_access_token;
  if (!token) {
    throw new Error('Failed to get tenant access token for bot info');
  }

  const resp = await fetch(`${baseUrl}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await resp.json()) as { bot?: { open_id?: string; name?: string } };
  const openId = data.bot?.open_id;
  if (!openId) {
    throw new Error('Failed to get bot open_id from /bot/v3/info');
  }

  return { openId, name: data.bot?.name };
}

export class MultiFeishuAppRuntime {
  private contexts: FeishuAppRuntimeContext[] = [];

  constructor(private readonly options: MultiFeishuAppRuntimeOptions) {}

  async initialize(): Promise<FeishuAppRuntimeContext> {
    if (this.options.disabled) {
      const context: FeishuAppRuntimeContext = {
        id: 'feishu-disabled',
        tenantKey: 'default',
        appId: this.options.primaryAppId || 'feishu-disabled',
        appSecretRef: '',
        appSecret: '',
        client: this.options.createLoopbackClient(),
        botOpenId: this.options.disabledBotOpenId,
        botName: 'OpenClaudeTag',
        eventMode: 'websocket',
        status: 'disabled',
        wsStatus: 'disabled',
        isPrimary: true,
        persisted: false,
        hasActiveBotBinding: false,
      };
      this.contexts = [context];
      return context;
    }

    const registrations = await this.loadRegistrations();
    if (registrations.length === 0) {
      throw new Error('No enabled Feishu app registrations found');
    }

    const contexts: FeishuAppRuntimeContext[] = [];
    for (let index = 0; index < registrations.length; index += 1) {
      const registration = registrations[index];
      const isPrimary =
        registration.appId === this.options.primaryAppId ||
        (!this.options.primaryAppId && index === 0);
      const context = await this.initializeRegistration(registration, isPrimary);
      contexts.push(context);
    }

    const primary = contexts.find((context) => context.isPrimary && context.status === 'healthy');
    const fallback = contexts.find((context) => context.status === 'healthy');
    if (!primary && !fallback) {
      throw new Error('No healthy Feishu app contexts available');
    }

    this.contexts = contexts;
    return primary ?? fallback!;
  }

  getPrimaryContext(): FeishuAppRuntimeContext {
    const primary =
      this.contexts.find((context) => context.isPrimary && context.status !== 'unhealthy') ??
      this.contexts.find((context) => context.status !== 'unhealthy');
    if (!primary) {
      throw new Error('No Feishu app context initialized');
    }
    return primary;
  }

  getHealthyContexts(): FeishuAppRuntimeContext[] {
    return this.contexts.filter((context) => context.status === 'healthy');
  }

  getContextById(id: string): FeishuAppRuntimeContext | null {
    return this.contexts.find((context) => context.id === id) ?? null;
  }

  getHealthSnapshot(): FeishuAppHealthSnapshot[] {
    return this.contexts.map((context) => ({
      id: context.id,
      tenantKey: context.tenantKey,
      appId: context.appId,
      botOpenId: context.botOpenId,
      botName: context.botName,
      eventMode: context.eventMode,
      status: context.status,
      wsStatus: context.wsStatus,
      error: context.error,
      isPrimary: context.isPrimary,
      hasActiveBotBinding: context.hasActiveBotBinding,
    }));
  }

  updateWsStatus(id: string, wsStatus: FeishuAppWsStatus, error?: string): void {
    const context = this.contexts.find((candidate) => candidate.id === id);
    if (!context) return;
    context.wsStatus = wsStatus;
    context.error = error ?? context.error;
  }

  private async loadRegistrations(): Promise<LoadedFeishuAppRegistration[]> {
    const rows = await this.options.db
      .select()
      .from(feishuApps)
      .where(eq(feishuApps.status, 'enabled'));

    if (rows.length > 0) {
      const bindingRows = await this.options.db
        .select({ feishuAppId: agentBotBindings.feishuAppId })
        .from(agentBotBindings)
        .where(eq(agentBotBindings.status, 'active'));
      const activeBindingAppIds = new Set(bindingRows.map((row) => row.feishuAppId));

      return rows.map((row) => ({
        id: row.id,
        tenantKey: row.tenantKey,
        appId: row.appId,
        appSecretRef: row.appSecretRef,
        appSecret: row.appSecret,
        botOpenId: row.botOpenId,
        botName: row.botName,
        eventMode: normalizeEventMode(row.eventMode),
        persisted: true,
        hasActiveBotBinding: activeBindingAppIds.has(row.id),
      }));
    }

    if (!this.options.primaryAppId || !this.options.primaryAppSecret) {
      return [];
    }

    return [
      {
        id: 'primary-env',
        tenantKey: 'default',
        appId: this.options.primaryAppId,
        appSecretRef: 'FEISHU_APP_SECRET',
        appSecret: null,
        botOpenId: null,
        botName: null,
        eventMode: this.options.primaryEventMode ?? 'websocket',
        persisted: false,
        hasActiveBotBinding: true,
      },
    ];
  }

  private async initializeRegistration(
    registration: LoadedFeishuAppRegistration,
    isPrimary: boolean,
  ): Promise<FeishuAppRuntimeContext> {
    try {
      const appSecret =
        resolveSecretRef(registration.appSecretRef, this.options.env) ??
        registration.appSecret ??
        (registration.appId === this.options.primaryAppId ? this.options.primaryAppSecret : null);
      if (!appSecret) {
        throw new Error(`Missing secret for Feishu app secret ref: ${registration.appSecretRef}`);
      }

      const clientFactory =
        this.options.createClient ?? ((appId, secret) => new FeishuClient({ appId, appSecret: secret }));
      const client = clientFactory(registration.appId, appSecret);
      this.options.applyClientDebugOverrides?.(client);

      let botOpenId = registration.botOpenId;
      let botName = registration.botName ?? undefined;
      if (!botOpenId) {
        const botInfo = await (this.options.fetchBotInfo ?? fetchBotInfoFromFeishu)({
          appId: registration.appId,
          appSecret,
        });
        botOpenId = botInfo.openId;
        botName = botInfo.name ?? botName;

        if (registration.persisted) {
          await this.options.db
            .update(feishuApps)
            .set({ botOpenId, botName, updatedAt: new Date() })
            .where(eq(feishuApps.id, registration.id));
        }
      }

      return {
        id: registration.id,
        tenantKey: registration.tenantKey,
        appId: registration.appId,
        appSecretRef: registration.appSecretRef,
        appSecret,
        client,
        botOpenId,
        botName,
        eventMode: registration.eventMode,
        status: 'healthy',
        wsStatus: 'starting',
        isPrimary,
        persisted: registration.persisted,
        hasActiveBotBinding: registration.hasActiveBotBinding,
      };
    } catch (error) {
      const message = errorMessage(error);
      this.options.logger?.warn(
        { appId: registration.appId, isPrimary, error: message },
        'Feishu app initialization failed',
      );
      if (isPrimary) {
        throw error;
      }

      return {
        id: registration.id,
        tenantKey: registration.tenantKey,
        appId: registration.appId,
        appSecretRef: registration.appSecretRef,
        appSecret: '',
        client: this.options.createLoopbackClient(),
        botOpenId: registration.botOpenId ?? '',
        botName: registration.botName ?? undefined,
        eventMode: registration.eventMode,
        status: 'unhealthy',
        wsStatus: 'unhealthy',
        error: message,
        isPrimary,
        persisted: registration.persisted,
        hasActiveBotBinding: registration.hasActiveBotBinding,
      };
    }
  }
}
