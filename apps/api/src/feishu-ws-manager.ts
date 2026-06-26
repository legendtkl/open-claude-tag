import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';

import { acquireFeishuAppLock, type FeishuAppLock } from './feishu-app-lock.js';
import { WsWatchdog } from './ws-watchdog.js';
import type { FeishuAppRuntimeContext, MultiFeishuAppRuntime } from './feishu-app-runtime.js';
import type { createTaskCardActionHandler } from './card-action-handler.js';

type TaskCardActionHandler = ReturnType<typeof createTaskCardActionHandler>;

export interface FeishuWsManagerDeps {
  logger: Logger;
  instanceId: string;
  instanceRole: string;
  feishuAccessDisabled: boolean;
  getRuntime: () => MultiFeishuAppRuntime;
  processEvent: (raw: unknown, appContext: FeishuAppRuntimeContext) => Promise<boolean>;
  getTaskCardActionHandler: () => TaskCardActionHandler | null;
}

interface ActiveWsClient {
  appId: string;
  watchdog: WsWatchdog;
  closeWsClient: () => void;
  appLock: FeishuAppLock;
}

/**
 * Owns the lifecycle of one Feishu WSClient per healthy websocket app:
 * duplicate-instance locking, watchdog-driven restarts, and teardown.
 */
export class FeishuWsManager {
  private readonly activeClients: ActiveWsClient[] = [];

  constructor(private readonly deps: FeishuWsManagerDeps) {}

  /** Watchdog of the first started client (the primary app). */
  get primaryWatchdog(): WsWatchdog | undefined {
    return this.activeClients[0]?.watchdog;
  }

  startAll(): void {
    const { logger, feishuAccessDisabled, instanceId, instanceRole, getRuntime } = this.deps;
    if (feishuAccessDisabled) {
      logger.info(
        { instanceId, instanceRole },
        'Feishu WSClient disabled for this instance',
      );
      return;
    }

    const runtime = getRuntime();
    for (const appContext of runtime.getHealthyContexts()) {
      if (appContext.eventMode !== 'websocket') {
        runtime.updateWsStatus(appContext.id, 'disabled');
        logger.info(
          { appId: appContext.appId, eventMode: appContext.eventMode },
          'Skipping Feishu WSClient for non-websocket app',
        );
        continue;
      }
      if (appContext.persisted && !appContext.hasActiveBotBinding) {
        runtime.updateWsStatus(appContext.id, 'disabled');
        logger.info(
          { appId: appContext.appId },
          'Skipping Feishu WSClient for app without active bot binding',
        );
        continue;
      }
      this.startClient(appContext);
    }
  }

  stopAll(): void {
    for (const active of this.activeClients) {
      active.watchdog.stop();
      active.closeWsClient();
      active.appLock.release();
    }
    this.activeClients.splice(0, this.activeClients.length);
  }

  private startClient(appContext: FeishuAppRuntimeContext): void {
    const { logger, getRuntime, processEvent, getTaskCardActionHandler } = this.deps;
    const runtime = getRuntime();

    const lockResult = acquireFeishuAppLock(appContext.appId);
    if (!lockResult.acquired || !lockResult.lock) {
      runtime.updateWsStatus(
        appContext.id,
        'unhealthy',
        `Feishu app ${appContext.appId} is already locked by pid ${lockResult.owner?.pid ?? 'unknown'}`,
      );
      logger.error(
        {
          appId: appContext.appId,
          ownerPid: lockResult.owner?.pid,
          ownerInstanceId: lockResult.owner?.instanceId,
          ownerCwd: lockResult.owner?.cwd,
        },
        'Refusing to start duplicate Feishu WSClient for app',
      );
      return;
    }

    const watchdog = new WsWatchdog();
    const eventDispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        watchdog.recordActivity();
        logger.info(
          {
            appId: appContext.appId,
            messageId: data.message.message_id,
            chatId: data.message.chat_id,
          },
          'Received Feishu message event',
        );
        try {
          const processed = await processEvent(data, appContext);
          if (!processed) {
            throw new Error('Feishu message event processing failed');
          }
        } catch (err) {
          logger.error({ err, appId: appContext.appId }, 'Failed to process event');
        }
      },
      'drive.notice.comment_add_v1': async (data: Record<string, unknown>) => {
        watchdog.recordActivity();
        logger.info(
          {
            appId: appContext.appId,
            fileToken: data.file_token,
            commentId: data.comment_id,
          },
          'Received Feishu document comment event',
        );
        try {
          const processed = await processEvent(data, appContext);
          if (!processed) {
            throw new Error('Feishu document comment event processing failed');
          }
        } catch (err) {
          logger.error({ err, appId: appContext.appId }, 'Failed to process document comment event');
        }
      },
      'card.action.trigger': async (data: Record<string, unknown>) => {
        watchdog.recordActivity();
        logger.info(
          { appId: appContext.appId, openMessageId: data.open_message_id, action: data.action },
          'Received Feishu card action',
        );
        try {
          const taskCardActionHandler = getTaskCardActionHandler();
          if (!taskCardActionHandler) {
            throw new Error('Task card action handler is not initialized');
          }
          return await taskCardActionHandler(data as any);
        } catch (err) {
          logger.error({ err, data, appId: appContext.appId }, 'Failed to process Feishu card action');
          return {
            toast: {
              type: 'error',
              content: 'Failed to process the card action.',
            },
          };
        }
      },
    });

    let activeWsClient: WSClient | null = null;

    function startWsClient(): void {
      if (activeWsClient) {
        logger.warn({ appId: appContext.appId }, 'startWsClient called while active');
        return;
      }
      runtime.updateWsStatus(appContext.id, 'starting');
      const client = new WSClient({
        appId: appContext.appId,
        appSecret: appContext.appSecret,
        loggerLevel: (process.env.LOG_LEVEL === 'debug' ? 4 : 3) as any,
      });
      activeWsClient = client;
      client
        .start({ eventDispatcher })
        .then(() => runtime.updateWsStatus(appContext.id, 'live'))
        .catch((err) => {
          runtime.updateWsStatus(appContext.id, 'unhealthy', (err as Error).message);
          logger.warn({ err, appId: appContext.appId }, 'Feishu WSClient.start failed');
        });
      logger.info({ appId: appContext.appId }, 'Feishu WSClient starting...');
    }

    function closeWsClient(): void {
      if (activeWsClient) {
        try {
          activeWsClient.close({ force: true });
        } catch (err) {
          logger.warn({ err, appId: appContext.appId }, 'Error closing WSClient');
        }
        activeWsClient = null;
      }
    }

    this.activeClients.push({
      appId: appContext.appId,
      watchdog,
      closeWsClient,
      appLock: lockResult.lock,
    });
    watchdog.start(startWsClient, closeWsClient);
    startWsClient();
  }
}
