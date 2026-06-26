/**
 * E2E tests for /schedule and permission enforcement.
 *
 * Requires a running API server on http://localhost:3000.
 * Run after `pnpm dev:api` with `pnpm --filter @open-tag/api test:e2e`.
 *
 * Uses POST /debug/simulate to inject events without real Feishu messages.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const OWNER_OPEN_ID = 'ou_seed000000000000000000000000000000';
const NON_OWNER_OPEN_ID = 'ou_e2e_non_owner_test_123';
const TASK_CARD_ACTION_RETRY = 'task_retry';
const TASK_CARD_ACTION_RETRY_RUNTIME = 'task_retry_runtime';
const DEBUG_TENANT_KEY = 'default';
const FEISHU_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'open-claude-tag-api-review-context-'));
  tempDirs.push(dir);
  return dir;
}

function chatTaskScopeId(chatId: string): string {
  return `${DEBUG_TENANT_KEY}:${chatId}`;
}

function decodeFeishuAtText(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function getWebhookVerificationToken(): string | undefined {
  return (
    process.env.FEISHU_CALLBACK_VERIFICATION_TOKEN ??
    process.env.FEISHU_VERIFICATION_TOKEN ??
    undefined
  );
}

function signFeishuWebhook(input: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  body: string;
}): string {
  return createHash('sha256')
    .update(`${input.timestamp}${input.nonce}${input.encryptKey}${input.body}`, 'utf8')
    .digest('hex');
}

function buildWebhookHeaders(body: string, options: { stale?: boolean } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY;
  if (!encryptKey) {
    return headers;
  }

  const timestamp = options.stale
    ? String(Math.floor(Date.now() / 1000) - 3_600)
    : String(Math.floor(Date.now() / 1000));
  const nonce = `e2e_nonce_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  headers['x-lark-request-timestamp'] = timestamp;
  headers['x-lark-request-nonce'] = nonce;
  headers['x-lark-signature'] = signFeishuWebhook({
    timestamp,
    nonce,
    encryptKey,
    body,
  });
  return headers;
}

async function postFeishuWebhook(payload: Record<string, unknown>, options?: { stale?: boolean }) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${API_URL}/webhooks/feishu`, {
    method: 'POST',
    headers: buildWebhookHeaders(body, options),
    body,
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function postChunkedWebhookBody(body: string): Promise<{ status: number; text: string }> {
  const url = new URL('/webhooks/feishu', API_URL);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body.slice(0, 512 * 1024));
    req.write(body.slice(512 * 1024));
    req.end();
  });
}

function modelFeishuWebhookTextFromOutgoingText(
  outgoingText: string,
): { text: string; extraMentions: Array<{ key: string; openId: string; name: string }> } {
  const extraMentions: Array<{ key: string; openId: string; name: string }> = [];
  const text = outgoingText.replace(
    /<at\s+user_id="([^"]+)">([\s\S]*?)<\/at>/g,
    (_match, openId: string, rawName: string) => {
      const key = `@_user_${extraMentions.length + 1}`;
      extraMentions.push({ key, openId, name: decodeFeishuAtText(rawName) });
      return key;
    },
  );
  return { text, extraMentions };
}

async function simulate(
  text: string,
  senderOpenId = NON_OWNER_OPEN_ID,
  chatId = 'debug_chat_001',
  options?: {
    chatType?: 'p2p' | 'group';
    mentionBot?: boolean;
    threadId?: string;
    rootMessageId?: string;
    parentMessageId?: string;
    referenceMessageId?: string;
    quoteMessageId?: string;
    senderType?: string;
    extraMentions?: Array<{ key?: string; openId: string; name?: string }>;
    feishuAppId?: string;
    virtualAgentHandle?: string;
    expectedAgentId?: string;
    expectedAgentHandle?: string;
    tenantKey?: string;
    senderUnionId?: string;
    eventId?: string;
    messageId?: string;
    referencedMessage?: {
      messageId?: string;
      messageType?: string;
      content?: unknown;
      imageKey?: string;
      threadId?: string;
      rootMessageId?: string;
      parentMessageId?: string;
      referenceMessageId?: string;
      senderName?: string;
    };
    referencedMessages?: Array<{
      messageId: string;
      messageType?: string;
      content?: unknown;
      imageKey?: string;
      threadId?: string;
      rootMessageId?: string;
      parentMessageId?: string;
      referenceMessageId?: string;
      senderName?: string;
    }>;
  },
): Promise<{
  ok: boolean;
  eventId?: string;
  messageId?: string;
  error?: string;
  feishuAppId?: string;
  taskId?: string;
  agent?: { id: string; handle?: string; displayName?: string } | null;
}> {
  const res = await fetch(`${API_URL}/debug/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      senderOpenId,
      chatId,
      skipTaskExecution: true,
      ...(options?.chatType ? { chatType: options.chatType } : {}),
      ...(options?.mentionBot ? { mentionBot: options.mentionBot } : {}),
      ...(options?.threadId ? { threadId: options.threadId } : {}),
      ...(options?.rootMessageId ? { rootMessageId: options.rootMessageId } : {}),
      ...(options?.parentMessageId ? { parentMessageId: options.parentMessageId } : {}),
      ...(options?.referenceMessageId ? { referenceMessageId: options.referenceMessageId } : {}),
      ...(options?.quoteMessageId ? { quoteMessageId: options.quoteMessageId } : {}),
      ...(options?.senderType ? { senderType: options.senderType } : {}),
      ...(options?.extraMentions ? { extraMentions: options.extraMentions } : {}),
      ...(options?.feishuAppId ? { feishuAppId: options.feishuAppId } : {}),
      ...(options?.virtualAgentHandle ? { virtualAgentHandle: options.virtualAgentHandle } : {}),
      ...(options?.expectedAgentId ? { expectedAgentId: options.expectedAgentId } : {}),
      ...(options?.expectedAgentHandle ? { expectedAgentHandle: options.expectedAgentHandle } : {}),
      ...(options?.tenantKey ? { tenantKey: options.tenantKey } : {}),
      ...(options?.senderUnionId ? { senderUnionId: options.senderUnionId } : {}),
      ...(options?.eventId ? { eventId: options.eventId } : {}),
      ...(options?.messageId ? { messageId: options.messageId } : {}),
      ...(options?.referencedMessage ? { referencedMessage: options.referencedMessage } : {}),
      ...(options?.referencedMessages ? { referencedMessages: options.referencedMessages } : {}),
    }),
  });
  return res.json() as Promise<{
    ok: boolean;
    eventId?: string;
    messageId?: string;
    error?: string;
    feishuAppId?: string;
    taskId?: string;
    agent?: { id: string; handle?: string; displayName?: string } | null;
  }>;
}

async function getSessionTasks(params: {
  chatId: string;
  messageId?: string;
}): Promise<{
  ok: boolean;
  sessionId: string | null;
  tasks: Array<{
    id: string;
    sessionId: string;
    agentId: string | null;
    feishuAppId: string | null;
    taskType: string;
    goal: string;
    status: string;
    runtimeHint: string | null;
    constraints: Record<string, unknown>;
    userMessageId: string | null;
  }>;
}> {
  const res = await fetch(`${API_URL}/debug/session-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<{
    ok: boolean;
    sessionId: string | null;
    tasks: Array<{
      id: string;
      sessionId: string;
      agentId: string | null;
      feishuAppId: string | null;
      taskType: string;
      goal: string;
      status: string;
      runtimeHint: string | null;
      constraints: Record<string, unknown>;
      userMessageId: string | null;
    }>;
  }>;
}

async function registerAgentBot(params: {
  botOpenId: string;
  handle: string;
  displayName: string;
  botName?: string;
  tenantKey?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  agent?: { id: string; handle: string; displayName: string };
  feishuApp?: { id: string; botOpenId: string };
  binding?: { id: string };
}> {
  const res = await fetch(`${API_URL}/debug/register-agent-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<{
    ok: boolean;
    error?: string;
    agent?: { id: string; handle: string; displayName: string };
    feishuApp?: { id: string; botOpenId: string };
    binding?: { id: string };
  }>;
}

async function getLatestDiscussion(params: {
  chatId: string;
  rootThreadId?: string;
}): Promise<{
  ok: boolean;
  discussion: null | {
    id: string;
    sessionId: string;
    topic: string;
    status: string;
    roundLimit: number;
    currentRound: number;
    currentTurnIndex: number;
    rootThreadId: string;
  };
  participants: Array<{
    id: string;
    agentId: string;
    feishuAppId: string | null;
    botOpenId: string | null;
    role: string | null;
    orderIndex: number;
    handle: string;
    displayName: string;
  }>;
  tasks: Array<{
    id: string;
    agentId: string | null;
    feishuAppId: string | null;
    status: string;
    constraints: Record<string, unknown>;
  }>;
}> {
  const res = await fetch(`${API_URL}/debug/latest-discussion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<{
    ok: boolean;
    discussion: null | {
      id: string;
      sessionId: string;
      topic: string;
      status: string;
      roundLimit: number;
      currentRound: number;
      currentTurnIndex: number;
      rootThreadId: string;
    };
    participants: Array<{
      id: string;
      agentId: string;
      feishuAppId: string | null;
      botOpenId: string | null;
      role: string | null;
      orderIndex: number;
      handle: string;
      displayName: string;
    }>;
    tasks: Array<{
      id: string;
      agentId: string | null;
      feishuAppId: string | null;
      status: string;
      constraints: Record<string, unknown>;
    }>;
  }>;
}

function makePostCommandContent(
  text: string,
  locale: 'zh_cn' | 'en_us' = 'zh_cn',
): Record<string, unknown> {
  return {
    [locale]: {
      title: '',
      content: [[{ tag: 'text', text }]],
    },
  };
}

async function simulatePost(
  text: string,
  senderOpenId = NON_OWNER_OPEN_ID,
  chatId = 'debug_chat_001',
  locale: 'zh_cn' | 'en_us' = 'zh_cn',
): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  const res = await fetch(`${API_URL}/debug/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      senderOpenId,
      chatId,
      messageType: 'post',
      postContent: makePostCommandContent(text, locale),
      skipTaskExecution: true,
    }),
  });
  return res.json() as Promise<{ ok: boolean; eventId?: string; error?: string }>;
}

async function getSentMessages(params: {
  chatId?: string;
  msgType?: string;
  limit?: number;
  receiveIdType?: 'chat_id' | 'open_id';
  receiveId?: string;
}): Promise<{
  ok: boolean;
  messages: Array<{
    receiveIdType: string;
    receiveId: string;
    msgType: string;
    text?: string;
    replyToMessageId?: string;
    sentAt: string;
  }>;
}> {
  const query = new URLSearchParams({
    msgType: params.msgType ?? 'text',
    limit: String(params.limit ?? 5),
  });
  if (params.chatId) query.set('chatId', params.chatId);
  if (params.receiveIdType) query.set('receiveIdType', params.receiveIdType);
  if (params.receiveId) query.set('receiveId', params.receiveId);
  const res = await fetch(`${API_URL}/debug/sent-messages?${query.toString()}`);
  return res.json() as Promise<{
    ok: boolean;
    messages: Array<{
      receiveIdType: string;
      receiveId: string;
      msgType: string;
      text?: string;
      replyToMessageId?: string;
      sentAt: string;
    }>;
  }>;
}

async function getHealth(): Promise<{
  status: string;
  db: string;
  instanceRole?: 'primary' | 'isolated';
  feishu?: {
    access?: string;
    apps?: Array<{
      appId: string;
      botOpenId: string;
      botName?: string;
      eventMode?: string;
      status?: string;
    }>;
  };
}> {
  const res = await fetch(`${API_URL}/health`);
  return res.json() as Promise<{
    status: string;
    db: string;
    instanceRole?: 'primary' | 'isolated';
    feishu?: {
      access?: string;
      apps?: Array<{
        appId: string;
        botOpenId: string;
        botName?: string;
        eventMode?: string;
        status?: string;
      }>;
    };
  }>;
}

async function getLatestTask(params: { chatId?: string; goal?: string }): Promise<{
  ok: boolean;
  task: null | {
    id: string;
    sessionId: string;
    parentTaskId: string | null;
    agentId: string | null;
    feishuAppId: string | null;
    taskType: string;
    goal: string;
    status: string;
    runtimeHint: string | null;
    feedbackState: string | null;
    feedbackMessageId: string | null;
  };
}> {
  const res = await fetch(`${API_URL}/debug/latest-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<{
    ok: boolean;
    task: null | {
      id: string;
      sessionId: string;
      parentTaskId: string | null;
      agentId: string | null;
      feishuAppId: string | null;
      taskType: string;
      goal: string;
      status: string;
      runtimeHint: string | null;
      feedbackState: string | null;
      feedbackMessageId: string | null;
    };
  }>;
}

async function getTaskLink(taskId: string): Promise<{
  ok: boolean;
  link: null | {
    taskId: string;
    feishuTaskGuid: string | null;
    feishuTaskUrl: string | null;
    sourceMessageId: string | null;
    sourceTopicKey: string | null;
    sourceTopicUrl: string | null;
    lastSyncedStatus: string | null;
    lastSyncError: string | null;
  };
}> {
  const res = await fetch(`${API_URL}/debug/task-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
  return res.json() as Promise<{
    ok: boolean;
    link: null | {
      taskId: string;
      feishuTaskGuid: string | null;
      feishuTaskUrl: string | null;
      sourceMessageId: string | null;
      sourceTopicKey: string | null;
      sourceTopicUrl: string | null;
      lastSyncedStatus: string | null;
      lastSyncError: string | null;
    };
  }>;
}

async function getTaskTrackingSpace(params: { scopeType: string; scopeId: string }): Promise<{
  ok: boolean;
  space: null | {
    id: string;
    scopeType: string;
    scopeId: string;
    tasklistGuid: string;
    statusFieldGuid: string;
    statusOptions: Record<string, string>;
    sections: Record<string, string>;
  };
}> {
  const res = await fetch(`${API_URL}/debug/task-tracking-space`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<{
    ok: boolean;
    space: null | {
      id: string;
      scopeType: string;
      scopeId: string;
      tasklistGuid: string;
      statusFieldGuid: string;
      statusOptions: Record<string, string>;
      sections: Record<string, string>;
    };
  }>;
}

async function deleteTaskTrackingSpace(params: {
  scopeType: string;
  scopeId: string;
}): Promise<{ ok: boolean; deletedCount: number }> {
  const res = await fetch(`${API_URL}/debug/delete-task-tracking-space`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<{ ok: boolean; deletedCount: number }>;
}

async function setTaskStatus(
  taskId: string,
  status: 'completed' | 'failed',
  options: { result?: unknown; workspacePath?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/debug/task-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, status, ...options }),
  });
  return res.json() as Promise<{ ok: boolean; error?: string }>;
}

async function sendTaskFeedback(params: {
  taskId: string;
  status: 'completed' | 'failed';
  resultText?: string;
  errorText?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  replyTarget?: string;
  completionMessageId?: string;
  sentMessageIds?: string[];
}> {
  const res = await fetch(`${API_URL}/debug/task-feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<{
    ok: boolean;
    error?: string;
    replyTarget?: string;
    completionMessageId?: string;
    sentMessageIds?: string[];
  }>;
}

async function simulateCardAction(
  taskId: string,
  action: string,
  runtime?: string,
  options: { openId?: string; openChatId?: string; token?: string } = {},
): Promise<{
  ok: boolean;
  response?: { toast?: { type?: string; content?: string } };
  error?: string;
}> {
  const res = await fetch(`${API_URL}/debug/simulate-card-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskId,
      action,
      runtime,
      openId: options.openId ?? OWNER_OPEN_ID,
      openChatId: options.openChatId,
      token: options.token,
    }),
  });
  return res.json() as Promise<{
    ok: boolean;
    response?: { toast?: { type?: string; content?: string } };
    error?: string;
  }>;
}

// ── Pre-flight ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  const health = await getHealth();
  if (health.status !== 'ok') {
    throw new Error(`API server is not healthy: ${JSON.stringify(health)}`);
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('E2E: task creation', () => {
  async function registerDiscussionBots(suffix: string) {
    const first = await registerAgentBot({
      botOpenId: `ou_discuss_a_${suffix}`,
      handle: `discuss-a-${suffix}`,
      displayName: `Discuss A ${suffix}`,
    });
    const second = await registerAgentBot({
      botOpenId: `ou_discuss_b_${suffix}`,
      handle: `discuss-b-${suffix}`,
      displayName: `Discuss B ${suffix}`,
    });
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(first.agent).toBeTruthy();
    expect(second.agent).toBeTruthy();
    expect(first.feishuApp).toBeTruthy();
    expect(second.feishuApp).toBeTruthy();
    return { first, second };
  }

  function discussionOrchestrationEnabled() {
    return ['1', 'true', 'yes'].includes(
      (process.env.DISCUSSION_ORCHESTRATION_ENABLED ?? '').toLowerCase(),
    );
  }

  function expectedDiscussionMaxRounds() {
    const parsed = Number.parseInt(process.env.DISCUSSION_MAX_ROUNDS ?? '3', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
  }

  it.runIf(!discussionOrchestrationEnabled())(
    'creates two tasks on one bootstrap session for concurrent same-message bot mentions',
    async () => {
    const chatId = `debug_dual_bot_root_${Date.now()}`;
    const messageId = `om_dual_bot_root_${Date.now()}`;
    const text = '@R2D2 @性能成本小助手 你们俩讨论一下今天的中国高考情况';

    const [first, second] = await Promise.all([
      simulate(text, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        mentionBot: true,
        eventId: `debug_dual_r2d2_${Date.now()}`,
        messageId,
      }),
      simulate(text, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        mentionBot: true,
        eventId: `debug_dual_perf_${Date.now()}`,
        messageId,
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const sessionTasks = await getSessionTasks({ chatId, messageId });
    expect(sessionTasks.ok).toBe(true);
    expect(sessionTasks.sessionId).toBeTruthy();
    expect(sessionTasks.tasks).toHaveLength(2);
    expect(new Set(sessionTasks.tasks.map((task) => task.id))).toHaveLength(2);
    expect(new Set(sessionTasks.tasks.map((task) => task.sessionId))).toEqual(
      new Set([sessionTasks.sessionId!]),
    );
    expect(sessionTasks.tasks.every((task) => task.userMessageId === messageId)).toBe(true);
    expect(
      sessionTasks.tasks.every((task) =>
        ['queued', 'starting', 'running', 'completed'].includes(task.status),
      ),
    ).toBe(true);
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'creates one discussion and one first-turn task for same-root /discuss multi-app delivery',
    async () => {
    const suffix = `${Date.now()}`;
    const { first, second } = await registerDiscussionBots(suffix);
    const chatId = `debug_discuss_root_${suffix}`;
    const messageId = `om_discuss_root_${suffix}`;
    const text = '/discuss 正方给 @_user_1，@_user_2 你是反方，讨论生产环境引入 AI Coding';
    const extraMentions = [
      {
        key: '@_user_1',
        openId: first.feishuApp!.botOpenId,
        name: first.agent!.displayName,
      },
      {
        key: '@_user_2',
        openId: second.feishuApp!.botOpenId,
        name: second.agent!.displayName,
      },
    ];

    const [firstDelivery, secondDelivery] = await Promise.all([
      simulate(text, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        extraMentions,
        eventId: `debug_discuss_a_${suffix}`,
        messageId,
      }),
      simulate(text, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: second.feishuApp!.id,
        extraMentions,
        eventId: `debug_discuss_b_${suffix}`,
        messageId,
      }),
    ]);
    expect(firstDelivery.ok).toBe(true);
    expect(secondDelivery.ok).toBe(true);

    const result = await getLatestDiscussion({ chatId, rootThreadId: messageId });
    expect(result.ok).toBe(true);
    expect(result.discussion).toMatchObject({
      rootThreadId: messageId,
      status: 'active',
      roundLimit: expectedDiscussionMaxRounds(),
      currentRound: 1,
      currentTurnIndex: 0,
    });
    expect(result.participants.map((participant) => participant.handle)).toEqual([
      first.agent!.handle,
      second.agent!.handle,
    ]);
    expect(result.participants.map((participant) => participant.role)).toEqual(['正方', '反方']);
    expect(result.participants.map((participant) => participant.feishuAppId)).toEqual([
      first.feishuApp!.id,
      second.feishuApp!.id,
    ]);
    expect(result.participants.map((participant) => participant.botOpenId)).toEqual([
      first.feishuApp!.botOpenId,
      second.feishuApp!.botOpenId,
    ]);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      agentId: result.participants[0].agentId,
      feishuAppId: first.feishuApp!.id,
      status: 'queued',
    });
    expect(result.tasks[0].constraints).toMatchObject({
      sourceCommand: '/discuss',
      discussionId: result.discussion!.id,
      discussionParticipantId: result.participants[0].id,
      discussionRound: 1,
      discussionTurnIndex: 0,
      userMessageId: messageId,
    });
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'accepts discussion participants referenced by active agent handles in rendered text',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`handle-${suffix}`);
      const chatId = `debug_discuss_handle_${suffix}`;
      const messageId = `om_discuss_handle_${suffix}`;
      const text = `@${first.agent!.handle} @${second.agent!.handle} 你俩讨论一下高考`;

      const [firstDelivery, secondDelivery] = await Promise.all([
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: first.feishuApp!.id,
          mentionBot: true,
          eventId: `debug_discuss_handle_a_${suffix}`,
          messageId,
        }),
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: second.feishuApp!.id,
          mentionBot: true,
          eventId: `debug_discuss_handle_b_${suffix}`,
          messageId,
        }),
      ]);
      expect(firstDelivery.ok).toBe(true);
      expect(secondDelivery.ok).toBe(true);

      const result = await getLatestDiscussion({ chatId, rootThreadId: messageId });
      expect(result.ok).toBe(true);
      expect(result.discussion).toMatchObject({
        rootThreadId: messageId,
        status: 'active',
      });
      expect(new Set(result.participants.map((participant) => participant.handle))).toEqual(
        new Set([first.agent!.handle, second.agent!.handle]),
      );
      expect(new Set(result.participants.map((participant) => participant.feishuAppId))).toEqual(
        new Set([first.feishuApp!.id, second.feishuApp!.id]),
      );
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]).toMatchObject({
        agentId: result.participants[0].agentId,
        feishuAppId: result.participants[0].feishuAppId,
        status: 'queued',
      });
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'cancels an active discussion from an explicit human thread interrupt',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`cancel-${suffix}`);
      const chatId = `debug_discuss_cancel_${suffix}`;
      const messageId = `om_discuss_cancel_root_${suffix}`;
      const cancelMessageId = `om_discuss_cancel_reply_${suffix}`;
      const text = '/discuss 正方给 @_user_1，@_user_2 你是反方，讨论部署窗口是否应该冻结';
      const extraMentions = [
        {
          key: '@_user_1',
          openId: first.feishuApp!.botOpenId,
          name: first.agent!.displayName,
        },
        {
          key: '@_user_2',
          openId: second.feishuApp!.botOpenId,
          name: second.agent!.displayName,
        },
      ];

      const created = await simulate(text, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        extraMentions,
        eventId: `debug_discuss_cancel_create_${suffix}`,
        messageId,
      });
      expect(created.ok).toBe(true);

      const cancel = await simulate('cancel discussion', OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        mentionBot: true,
        rootMessageId: messageId,
        parentMessageId: messageId,
        eventId: `debug_discuss_cancel_${suffix}`,
        messageId: cancelMessageId,
      });
      expect(cancel.ok).toBe(true);

      const result = await getLatestDiscussion({ chatId, rootThreadId: messageId });
      expect(result.ok).toBe(true);
      expect(result.discussion).toMatchObject({
        rootThreadId: messageId,
        status: 'cancelled',
      });

      const cancelTasks = await getSessionTasks({ chatId, messageId: cancelMessageId });
      expect(cancelTasks.ok).toBe(true);
      expect(cancelTasks.tasks).toHaveLength(0);
    },
  );

  it.runIf(!discussionOrchestrationEnabled())(
    'keeps /discuss multi-app delivery on ordinary routing when orchestration is disabled',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`off-${suffix}`);
      const chatId = `debug_discuss_off_${suffix}`;
      const messageId = `om_discuss_off_${suffix}`;
      const text = '/discuss @_user_1 @_user_2 讨论生产环境引入 AI Coding';
      const extraMentions = [
        {
          key: '@_user_1',
          openId: first.feishuApp!.botOpenId,
          name: first.agent!.displayName,
        },
        {
          key: '@_user_2',
          openId: second.feishuApp!.botOpenId,
          name: second.agent!.displayName,
        },
      ];

      const [firstDelivery, secondDelivery] = await Promise.all([
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: first.feishuApp!.id,
          extraMentions,
          eventId: `debug_discuss_off_a_${suffix}`,
          messageId,
        }),
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: second.feishuApp!.id,
          extraMentions,
          eventId: `debug_discuss_off_b_${suffix}`,
          messageId,
        }),
      ]);
      expect(firstDelivery.ok).toBe(true);
      expect(secondDelivery.ok).toBe(true);

      const discussion = await getLatestDiscussion({ chatId, rootThreadId: messageId });
      expect(discussion.discussion).toBeNull();

      const sessionTasks = await getSessionTasks({ chatId, messageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(2);
      expect(new Set(sessionTasks.tasks.map((task) => task.feishuAppId))).toEqual(
        new Set([first.feishuApp!.id, second.feishuApp!.id]),
      );
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'persists relay metadata only on the primary task',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`relay-${suffix}`);
      const chatId = `debug_relay_route_${suffix}`;
      const messageId = `om_relay_route_${suffix}`;
      const text = '@_user_1 分析这个方案，完成后请 @_user_2 review';
      const extraMentions = [
        {
          key: '@_user_1',
          openId: first.feishuApp!.botOpenId,
          name: first.agent!.displayName,
        },
        {
          key: '@_user_2',
          openId: second.feishuApp!.botOpenId,
          name: second.agent!.displayName,
        },
      ];

      const [firstDelivery, secondDelivery] = await Promise.all([
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: first.feishuApp!.id,
          extraMentions,
          eventId: `debug_relay_a_${suffix}`,
          messageId,
        }),
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: second.feishuApp!.id,
          extraMentions,
          eventId: `debug_relay_b_${suffix}`,
          messageId,
        }),
      ]);
      expect(firstDelivery.ok).toBe(true);
      expect(secondDelivery.ok).toBe(true);

      const sessionTasks = await getSessionTasks({ chatId, messageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(1);
      const [primaryTask] = sessionTasks.tasks;
      expect(primaryTask.feishuAppId).toBe(first.feishuApp!.id);

      // Deferred delivery posted a waiting ack (plain text, no real <at> tag)
      const sentAfterIntake = await getSentMessages({ chatId, limit: 10 });
      const waitingAcks = sentAfterIntake.messages.filter((message) =>
        message.text?.includes('收到，等'),
      );
      expect(waitingAcks).toHaveLength(1);
      expect(waitingAcks[0].text).toContain(first.agent!.displayName);
      expect(waitingAcks[0].text).not.toContain('<at ');

      const duplicatePrimaryDelivery = await simulate(text, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        extraMentions,
        eventId: `debug_relay_a_duplicate_${suffix}`,
        messageId,
      });
      expect(duplicatePrimaryDelivery.ok).toBe(true);

      const duplicateDeferredDelivery = await simulate(text, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: second.feishuApp!.id,
        extraMentions,
        eventId: `debug_relay_b_duplicate_${suffix}`,
        messageId,
      });
      expect(duplicateDeferredDelivery.ok).toBe(true);

      const replayedSessionTasks = await getSessionTasks({ chatId, messageId });
      expect(replayedSessionTasks.ok).toBe(true);
      expect(replayedSessionTasks.tasks).toHaveLength(1);
      expect(replayedSessionTasks.tasks[0].id).toBe(primaryTask.id);

      // Contract idempotency: the replayed deferred delivery posts no second ack
      const sentAfterReplay = await getSentMessages({ chatId, limit: 10 });
      expect(
        sentAfterReplay.messages.filter((message) => message.text?.includes('收到，等')),
      ).toHaveLength(1);
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'routes generic handle-style delegate text only to the primary delivery',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`relay-handle-${suffix}`);
      const chatId = `debug_relay_handle_${suffix}`;
      const messageId = `om_relay_handle_${suffix}`;
      const firstDeliveryText = `@_user_1 新增一个文件 1.txt，完成之后让 @${second.agent!.handle} 继续实现测试`;
      const secondDeliveryText = `@${first.agent!.handle} 新增一个文件 1.txt，完成之后让 @_user_1 继续实现测试`;

      const [firstDelivery, secondDelivery] = await Promise.all([
        simulate(firstDeliveryText, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: first.feishuApp!.id,
          extraMentions: [
            {
              key: '@_user_1',
              openId: first.feishuApp!.botOpenId,
              name: first.agent!.displayName,
            },
          ],
          eventId: `debug_relay_handle_a_${suffix}`,
          messageId,
        }),
        simulate(secondDeliveryText, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: second.feishuApp!.id,
          extraMentions: [
            {
              key: '@_user_1',
              openId: second.feishuApp!.botOpenId,
              name: second.agent!.displayName,
            },
          ],
          eventId: `debug_relay_handle_b_${suffix}`,
          messageId,
        }),
      ]);
      expect(firstDelivery.ok).toBe(true);
      expect(secondDelivery.ok).toBe(true);

      const sessionTasks = await getSessionTasks({ chatId, messageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(1);
      const [primaryTask] = sessionTasks.tasks;
      expect(primaryTask.feishuAppId).toBe(first.feishuApp!.id);

      const sent = await getSentMessages({ chatId, limit: 10 });
      const waitingAcks = sent.messages.filter((message) => message.text?.includes('收到，等'));
      expect(waitingAcks).toHaveLength(1);
      expect(waitingAcks[0].text).toContain('继续实现测试');
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'collapses the verb+完/艾特 incident message to a single primary with a waiting ack',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`relay-wan-${suffix}`);
      const chatId = `debug_relay_wan_${suffix}`;
      const messageId = `om_relay_wan_${suffix}`;
      const text = '@_user_1 合并 /session 和 /sessions 命令，合并完艾特 @_user_2 进行 code review';
      const extraMentions = [
        {
          key: '@_user_1',
          openId: first.feishuApp!.botOpenId,
          name: first.agent!.displayName,
        },
        {
          key: '@_user_2',
          openId: second.feishuApp!.botOpenId,
          name: second.agent!.displayName,
        },
      ];

      const [firstDelivery, secondDelivery] = await Promise.all([
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: first.feishuApp!.id,
          extraMentions,
          eventId: `debug_relay_wan_a_${suffix}`,
          messageId,
        }),
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: second.feishuApp!.id,
          extraMentions,
          eventId: `debug_relay_wan_b_${suffix}`,
          messageId,
        }),
      ]);
      expect(firstDelivery.ok).toBe(true);
      expect(secondDelivery.ok).toBe(true);

      const sessionTasks = await getSessionTasks({ chatId, messageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(1);
      expect(sessionTasks.tasks[0].feishuAppId).toBe(first.feishuApp!.id);

      const sent = await getSentMessages({ chatId, limit: 10 });
      const waitingAcks = sent.messages.filter((message) => message.text?.includes('收到，等'));
      expect(waitingAcks).toHaveLength(1);
      // Delegate verb 艾特 and mention tokens are stripped from the relayed goal
      expect(waitingAcks[0].text).toContain('code review');
      expect(waitingAcks[0].text).not.toContain('艾特');
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'persists the relay from the primary delivery alone; a late deferred delivery only adds the ack',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`relay-late-${suffix}`);
      const chatId = `debug_relay_late_${suffix}`;
      const messageId = `om_relay_late_${suffix}`;
      const text = '@_user_1 分析这个方案，完成后请 @_user_2 review';
      const extraMentions = [
        {
          key: '@_user_1',
          openId: first.feishuApp!.botOpenId,
          name: first.agent!.displayName,
        },
        {
          key: '@_user_2',
          openId: second.feishuApp!.botOpenId,
          name: second.agent!.displayName,
        },
      ];

      // Only the primary delivery arrives (Feishu dropped the deferred copy)
      const primaryDelivery = await simulate(text, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        extraMentions,
        eventId: `debug_relay_late_a_${suffix}`,
        messageId,
      });
      expect(primaryDelivery.ok).toBe(true);

      const sessionTasks = await getSessionTasks({ chatId, messageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(1);
      const sentBefore = await getSentMessages({ chatId, limit: 10 });
      expect(
        sentBefore.messages.filter((message) => message.text?.includes('收到，等')),
      ).toHaveLength(0);

      // The deferred delivery lands late: it finds the primary-created contract
      // and only posts the waiting ack
      const deferredDelivery = await simulate(text, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: second.feishuApp!.id,
        extraMentions,
        eventId: `debug_relay_late_b_${suffix}`,
        messageId,
      });
      expect(deferredDelivery.ok).toBe(true);

      const tasksAfter = await getSessionTasks({ chatId, messageId });
      expect(tasksAfter.tasks).toHaveLength(1);
      const sentAfter = await getSentMessages({ chatId, limit: 10 });
      expect(
        sentAfter.messages.filter((message) => message.text?.includes('收到，等')),
      ).toHaveLength(1);
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'does not treat 完善 as a relay sequence marker',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`relay-neg-${suffix}`);
      const chatId = `debug_relay_neg_${suffix}`;
      const messageId = `om_relay_neg_${suffix}`;
      const text = '@_user_1 @_user_2 你们一起完善这个文档的结构';
      const extraMentions = [
        {
          key: '@_user_1',
          openId: first.feishuApp!.botOpenId,
          name: first.agent!.displayName,
        },
        {
          key: '@_user_2',
          openId: second.feishuApp!.botOpenId,
          name: second.agent!.displayName,
        },
      ];

      const [firstDelivery, secondDelivery] = await Promise.all([
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: first.feishuApp!.id,
          extraMentions,
          eventId: `debug_relay_neg_a_${suffix}`,
          messageId,
        }),
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: second.feishuApp!.id,
          extraMentions,
          eventId: `debug_relay_neg_b_${suffix}`,
          messageId,
        }),
      ]);
      expect(firstDelivery.ok).toBe(true);
      expect(secondDelivery.ok).toBe(true);

      // No sequencing semantics → fanout: both agents get tasks, no waiting ack
      const sessionTasks = await getSessionTasks({ chatId, messageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(2);

      const sent = await getSentMessages({ chatId, limit: 10 });
      expect(
        sent.messages.filter((message) => message.text?.includes('收到，等')),
      ).toHaveLength(0);
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'does not task possessive reference mentions',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`ref-${suffix}`);
      const chatId = `debug_reference_route_${suffix}`;
      const messageId = `om_reference_route_${suffix}`;
      const text = '@_user_1 review @_user_2 的结果';
      const extraMentions = [
        {
          key: '@_user_1',
          openId: first.feishuApp!.botOpenId,
          name: first.agent!.displayName,
        },
        {
          key: '@_user_2',
          openId: second.feishuApp!.botOpenId,
          name: second.agent!.displayName,
        },
      ];

      const [firstDelivery, secondDelivery] = await Promise.all([
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: first.feishuApp!.id,
          extraMentions,
          eventId: `debug_reference_actor_${suffix}`,
          messageId,
        }),
        simulate(text, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: second.feishuApp!.id,
          extraMentions,
          eventId: `debug_reference_ref_${suffix}`,
          messageId,
        }),
      ]);
      expect(firstDelivery.ok).toBe(true);
      expect(secondDelivery.ok).toBe(true);

      const sessionTasks = await getSessionTasks({ chatId, messageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(1);
      const [actorTask] = sessionTasks.tasks;
      expect(actorTask.feishuAppId).toBe(first.feishuApp!.id);
      expect(actorTask.constraints.multiMentionRouting).toMatchObject({
        route: 'reference',
      });
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'does not task possessive reference mentions in topic follow-ups',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`topic-ref-${suffix}`);
      const chatId = `debug_topic_reference_route_${suffix}`;
      const rootMessageId = `om_topic_reference_root_${suffix}`;
      const followupMessageId = `om_topic_reference_followup_${suffix}`;

      const root = await simulate('@_user_1 新增一个文件 3.txt，写入 hello world', OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        extraMentions: [
          {
            key: '@_user_1',
            openId: first.feishuApp!.botOpenId,
            name: first.agent!.displayName,
          },
        ],
        eventId: `debug_topic_reference_root_${suffix}`,
        messageId: rootMessageId,
      });
      expect(root.ok).toBe(true);
      const rootTasks = await getSessionTasks({ chatId, messageId: rootMessageId });
      expect(rootTasks.ok).toBe(true);
      expect(rootTasks.tasks).toHaveLength(1);
      const developerWorktree = tempWorktree();
      const completed = await setTaskStatus(rootTasks.tasks[0].id, 'completed', {
        workspacePath: developerWorktree,
        result: { output: { text: 'created 3.txt with hello world' } },
      });
      expect(completed.ok).toBe(true);

      const [reviewerDelivery, developerDelivery] = await Promise.all([
        simulate(
          `@_user_1 你来 review 一下 @${first.agent!.handle} 的结果`,
          OWNER_OPEN_ID,
          chatId,
          {
            chatType: 'group',
            feishuAppId: second.feishuApp!.id,
            extraMentions: [
              {
                key: '@_user_1',
                openId: second.feishuApp!.botOpenId,
                name: second.agent!.displayName,
              },
            ],
            threadId: rootMessageId,
            eventId: `debug_topic_reference_reviewer_${suffix}`,
            messageId: followupMessageId,
          },
        ),
        simulate(
          `@${second.agent!.handle} 你来 review 一下 @_user_1 的结果`,
          OWNER_OPEN_ID,
          chatId,
          {
            chatType: 'group',
            feishuAppId: first.feishuApp!.id,
            extraMentions: [
              {
                key: '@_user_1',
                openId: first.feishuApp!.botOpenId,
                name: first.agent!.displayName,
              },
            ],
            threadId: rootMessageId,
            eventId: `debug_topic_reference_developer_${suffix}`,
            messageId: followupMessageId,
          },
        ),
      ]);
      expect(reviewerDelivery.ok).toBe(true);
      expect(developerDelivery.ok).toBe(true);

      const sessionTasks = await getSessionTasks({ chatId, messageId: followupMessageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(1);
      const [actorTask] = sessionTasks.tasks;
      expect(actorTask.feishuAppId).toBe(second.feishuApp!.id);
      expect(actorTask.constraints.multiMentionRouting).toMatchObject({
        route: 'reference',
      });
      expect(actorTask.constraints.reviewContext).toMatchObject({
        source: 'reference',
        referencedAgentId: first.agent!.id,
        reviewedTaskId: rootTasks.tasks[0].id,
        reviewedResult: { output: { text: 'created 3.txt with hello world' } },
        worktreePath: developerWorktree,
        worktreeAccessMode: 'write',
      });
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'accepts app-sent visible relay wakes only when the target bot is truly mentioned',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`visible-wake-${suffix}`);
      const chatId = `debug_visible_wake_${suffix}`;
      const rootMessageId = `om_visible_wake_root_${suffix}`;
      const wakeMessageId = `om_visible_wake_followup_${suffix}`;

      const root = await simulate('@_user_1 新增一个文件 6.txt', OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        extraMentions: [
          {
            key: '@_user_1',
            openId: first.feishuApp!.botOpenId,
            name: first.agent!.displayName,
          },
        ],
        eventId: `debug_visible_wake_root_${suffix}`,
        messageId: rootMessageId,
      });
      expect(root.ok).toBe(true);
      const rootTasks = await getSessionTasks({ chatId, messageId: rootMessageId });
      expect(rootTasks.ok).toBe(true);
      expect(rootTasks.tasks).toHaveLength(1);
      const developerWorktree = tempWorktree();
      const completed = await setTaskStatus(rootTasks.tasks[0].id, 'completed', {
        workspacePath: developerWorktree,
        result: { output: { text: 'created 6.txt in Developer worktree' } },
      });
      expect(completed.ok).toBe(true);

      const outgoingVisibleWakeText = `<at user_id="${second.feishuApp!.botOpenId}">${second.agent!.displayName}</at> Review @${first.agent!.handle} 的结果`;
      const visibleWakeWebhook = modelFeishuWebhookTextFromOutgoingText(outgoingVisibleWakeText);
      expect(visibleWakeWebhook).toEqual({
        text: `@_user_1 Review @${first.agent!.handle} 的结果`,
        extraMentions: [
          {
            key: '@_user_1',
            openId: second.feishuApp!.botOpenId,
            name: second.agent!.displayName,
          },
        ],
      });
      const [targetDelivery, primaryAppDelivery] = await Promise.all([
        simulate(visibleWakeWebhook.text, first.feishuApp!.botOpenId, chatId, {
          chatType: 'group',
          feishuAppId: second.feishuApp!.id,
          senderType: 'app',
          extraMentions: visibleWakeWebhook.extraMentions,
          threadId: rootMessageId,
          eventId: `debug_visible_wake_target_${suffix}`,
          messageId: wakeMessageId,
        }),
        simulate(visibleWakeWebhook.text, first.feishuApp!.botOpenId, chatId, {
          chatType: 'group',
          feishuAppId: first.feishuApp!.id,
          senderType: 'app',
          extraMentions: visibleWakeWebhook.extraMentions,
          threadId: rootMessageId,
          eventId: `debug_visible_wake_primary_${suffix}`,
          messageId: wakeMessageId,
        }),
      ]);
      expect(targetDelivery.ok).toBe(true);
      expect(primaryAppDelivery.ok).toBe(true);

      const wakeTasks = await getSessionTasks({ chatId, messageId: wakeMessageId });
      expect(wakeTasks.ok).toBe(true);
      expect(wakeTasks.tasks).toHaveLength(1);
      const [reviewerTask] = wakeTasks.tasks;
      expect(reviewerTask.feishuAppId).toBe(second.feishuApp!.id);
      expect(reviewerTask.constraints.multiMentionRouting).toMatchObject({
        route: 'reference',
      });
      expect(reviewerTask.constraints.reviewContext).toMatchObject({
        source: 'reference',
        referencedAgentId: first.agent!.id,
        reviewedTaskId: rootTasks.tasks[0].id,
        reviewedResult: { output: { text: 'created 6.txt in Developer worktree' } },
        worktreePath: developerWorktree,
        worktreeAccessMode: 'write',
      });
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'keeps delegated reference follow-ups writable in the referenced worktree',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`topic-ref-write-${suffix}`);
      const chatId = `debug_topic_reference_write_${suffix}`;
      const rootMessageId = `om_topic_reference_write_root_${suffix}`;
      const followupMessageId = `om_topic_reference_write_followup_${suffix}`;

      const root = await simulate(`@_user_1 新增一个文件 4.txt`, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        extraMentions: [
          {
            key: '@_user_1',
            openId: first.feishuApp!.botOpenId,
            name: first.agent!.displayName,
          },
        ],
        eventId: `debug_topic_reference_write_root_${suffix}`,
        messageId: rootMessageId,
      });
      expect(root.ok).toBe(true);
      const rootTasks = await getSessionTasks({ chatId, messageId: rootMessageId });
      expect(rootTasks.ok).toBe(true);
      expect(rootTasks.tasks).toHaveLength(1);
      const developerWorktree = tempWorktree();
      const completed = await setTaskStatus(rootTasks.tasks[0].id, 'completed', {
        workspacePath: developerWorktree,
        result: { output: { text: 'created 4.txt' } },
      });
      expect(completed.ok).toBe(true);

      const [delegateDelivery, referencedDelivery] = await Promise.all([
        simulate(
          `@_user_1 继续修改 @${first.agent!.handle} 的结果`,
          OWNER_OPEN_ID,
          chatId,
          {
            chatType: 'group',
            feishuAppId: second.feishuApp!.id,
            extraMentions: [
              {
                key: '@_user_1',
                openId: second.feishuApp!.botOpenId,
                name: second.agent!.displayName,
              },
            ],
            threadId: rootMessageId,
            eventId: `debug_topic_reference_write_delegate_${suffix}`,
            messageId: followupMessageId,
          },
        ),
        simulate(
          `@${second.agent!.handle} 继续修改 @_user_1 的结果`,
          OWNER_OPEN_ID,
          chatId,
          {
            chatType: 'group',
            feishuAppId: first.feishuApp!.id,
            extraMentions: [
              {
                key: '@_user_1',
                openId: first.feishuApp!.botOpenId,
                name: first.agent!.displayName,
              },
            ],
            threadId: rootMessageId,
            eventId: `debug_topic_reference_write_ref_${suffix}`,
            messageId: followupMessageId,
          },
        ),
      ]);
      expect(delegateDelivery.ok).toBe(true);
      expect(referencedDelivery.ok).toBe(true);

      const sessionTasks = await getSessionTasks({ chatId, messageId: followupMessageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(1);
      const [actorTask] = sessionTasks.tasks;
      expect(actorTask.feishuAppId).toBe(second.feishuApp!.id);
      expect(actorTask.constraints.reviewContext).toMatchObject({
        source: 'reference',
        referencedAgentId: first.agent!.id,
        reviewedTaskId: rootTasks.tasks[0].id,
        worktreePath: developerWorktree,
        delegateGoal: expect.stringContaining('继续修改'),
        worktreeAccessMode: 'write',
      });
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'falls back to result-only review context when the referenced worktree is missing',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`topic-ref-missing-${suffix}`);
      const chatId = `debug_topic_reference_missing_${suffix}`;
      const rootMessageId = `om_topic_reference_missing_root_${suffix}`;
      const followupMessageId = `om_topic_reference_missing_followup_${suffix}`;

      const root = await simulate('@_user_1 新增一个文件 4.txt，写入 hello world', OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        extraMentions: [
          {
            key: '@_user_1',
            openId: first.feishuApp!.botOpenId,
            name: first.agent!.displayName,
          },
        ],
        eventId: `debug_topic_reference_missing_root_${suffix}`,
        messageId: rootMessageId,
      });
      expect(root.ok).toBe(true);
      const rootTasks = await getSessionTasks({ chatId, messageId: rootMessageId });
      expect(rootTasks.ok).toBe(true);
      expect(rootTasks.tasks).toHaveLength(1);
      const missingWorktree = `/tmp/open-claude-tag-missing-review-context-${suffix}`;
      const completed = await setTaskStatus(rootTasks.tasks[0].id, 'completed', {
        workspacePath: missingWorktree,
        result: { output: { text: 'created 4.txt with hello world' } },
      });
      expect(completed.ok).toBe(true);

      const [reviewerDelivery, developerDelivery] = await Promise.all([
        simulate(
          `@_user_1 你来 review 一下 @${first.agent!.handle} 的结果`,
          OWNER_OPEN_ID,
          chatId,
          {
            chatType: 'group',
            feishuAppId: second.feishuApp!.id,
            extraMentions: [
              {
                key: '@_user_1',
                openId: second.feishuApp!.botOpenId,
                name: second.agent!.displayName,
              },
            ],
            threadId: rootMessageId,
            eventId: `debug_topic_reference_missing_reviewer_${suffix}`,
            messageId: followupMessageId,
          },
        ),
        simulate(
          `@${second.agent!.handle} 你来 review 一下 @_user_1 的结果`,
          OWNER_OPEN_ID,
          chatId,
          {
            chatType: 'group',
            feishuAppId: first.feishuApp!.id,
            extraMentions: [
              {
                key: '@_user_1',
                openId: first.feishuApp!.botOpenId,
                name: first.agent!.displayName,
              },
            ],
            threadId: rootMessageId,
            eventId: `debug_topic_reference_missing_developer_${suffix}`,
            messageId: followupMessageId,
          },
        ),
      ]);
      expect(reviewerDelivery.ok).toBe(true);
      expect(developerDelivery.ok).toBe(true);

      const sessionTasks = await getSessionTasks({ chatId, messageId: followupMessageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(1);
      const [actorTask] = sessionTasks.tasks;
      expect(actorTask.feishuAppId).toBe(second.feishuApp!.id);
      expect(actorTask.constraints.reviewContext).toMatchObject({
        source: 'reference',
        referencedAgentId: first.agent!.id,
        reviewedTaskId: rootTasks.tasks[0].id,
        reviewedResult: { output: { text: 'created 4.txt with hello world' } },
        missingReason: 'worktree_unavailable',
        missingWorktreePath: missingWorktree,
      });
      expect(actorTask.constraints.reviewContext).not.toHaveProperty('worktreePath');
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'falls back cleanly when the referenced agent has no completed task in the session',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`topic-ref-empty-${suffix}`);
      const chatId = `debug_topic_reference_empty_${suffix}`;
      const rootMessageId = `om_topic_reference_empty_root_${suffix}`;
      const followupMessageId = `om_topic_reference_empty_followup_${suffix}`;

      const root = await simulate('@_user_1 准备新增一个文件 5.txt', OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        extraMentions: [
          {
            key: '@_user_1',
            openId: first.feishuApp!.botOpenId,
            name: first.agent!.displayName,
          },
        ],
        eventId: `debug_topic_reference_empty_root_${suffix}`,
        messageId: rootMessageId,
      });
      expect(root.ok).toBe(true);
      const rootTasks = await getSessionTasks({ chatId, messageId: rootMessageId });
      expect(rootTasks.ok).toBe(true);
      expect(rootTasks.tasks).toHaveLength(1);
      expect(rootTasks.tasks[0].status).not.toBe('completed');

      const [reviewerDelivery, developerDelivery] = await Promise.all([
        simulate(
          `@_user_1 你来 review 一下 @${first.agent!.handle} 的结果`,
          OWNER_OPEN_ID,
          chatId,
          {
            chatType: 'group',
            feishuAppId: second.feishuApp!.id,
            extraMentions: [
              {
                key: '@_user_1',
                openId: second.feishuApp!.botOpenId,
                name: second.agent!.displayName,
              },
            ],
            threadId: rootMessageId,
            eventId: `debug_topic_reference_empty_reviewer_${suffix}`,
            messageId: followupMessageId,
          },
        ),
        simulate(
          `@${second.agent!.handle} 你来 review 一下 @_user_1 的结果`,
          OWNER_OPEN_ID,
          chatId,
          {
            chatType: 'group',
            feishuAppId: first.feishuApp!.id,
            extraMentions: [
              {
                key: '@_user_1',
                openId: first.feishuApp!.botOpenId,
                name: first.agent!.displayName,
              },
            ],
            threadId: rootMessageId,
            eventId: `debug_topic_reference_empty_developer_${suffix}`,
            messageId: followupMessageId,
          },
        ),
      ]);
      expect(reviewerDelivery.ok).toBe(true);
      expect(developerDelivery.ok).toBe(true);

      const sessionTasks = await getSessionTasks({ chatId, messageId: followupMessageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(1);
      const [actorTask] = sessionTasks.tasks;
      expect(actorTask.feishuAppId).toBe(second.feishuApp!.id);
      expect(actorTask.constraints.reviewContext).toMatchObject({
        source: 'reference',
        referencedAgentId: first.agent!.id,
        missingReason: 'no_completed_task',
      });
      expect(actorTask.constraints.reviewContext).not.toHaveProperty('worktreePath');
      expect(actorTask.constraints.reviewContext).not.toHaveProperty('reviewedTaskId');
    },
  );

  it.runIf(discussionOrchestrationEnabled())(
    'keeps ordinary topic follow-up multi-app mentions on normal fanout',
    async () => {
      const suffix = `${Date.now()}`;
      const { first, second } = await registerDiscussionBots(`topic-plain-${suffix}`);
      const chatId = `debug_topic_plain_multi_${suffix}`;
      const rootMessageId = `om_topic_plain_root_${suffix}`;
      const followupMessageId = `om_topic_plain_followup_${suffix}`;

      const root = await simulate('@_user_1 先看一下这个话题', OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        extraMentions: [
          {
            key: '@_user_1',
            openId: first.feishuApp!.botOpenId,
            name: first.agent!.displayName,
          },
        ],
        eventId: `debug_topic_plain_root_${suffix}`,
        messageId: rootMessageId,
      });
      expect(root.ok).toBe(true);

      const [firstDelivery, secondDelivery] = await Promise.all([
        simulate(`@_user_1 @${second.agent!.handle} 帮我看下这个问题`, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: first.feishuApp!.id,
          extraMentions: [
            {
              key: '@_user_1',
              openId: first.feishuApp!.botOpenId,
              name: first.agent!.displayName,
            },
          ],
          threadId: rootMessageId,
          eventId: `debug_topic_plain_first_${suffix}`,
          messageId: followupMessageId,
        }),
        simulate(`@${first.agent!.handle} @_user_1 帮我看下这个问题`, OWNER_OPEN_ID, chatId, {
          chatType: 'group',
          feishuAppId: second.feishuApp!.id,
          extraMentions: [
            {
              key: '@_user_1',
              openId: second.feishuApp!.botOpenId,
              name: second.agent!.displayName,
            },
          ],
          threadId: rootMessageId,
          eventId: `debug_topic_plain_second_${suffix}`,
          messageId: followupMessageId,
        }),
      ]);
      expect(firstDelivery.ok).toBe(true);
      expect(secondDelivery.ok).toBe(true);

      const sessionTasks = await getSessionTasks({ chatId, messageId: followupMessageId });
      expect(sessionTasks.ok).toBe(true);
      expect(sessionTasks.tasks).toHaveLength(2);
      expect(new Set(sessionTasks.tasks.map((task) => task.feishuAppId))).toEqual(
        new Set([first.feishuApp!.id, second.feishuApp!.id]),
      );
      expect(
        sessionTasks.tasks.every(
          (task) =>
            !task.constraints.multiMentionRouting ||
            (task.constraints.multiMentionRouting as Record<string, unknown>).route !==
              'reference',
        ),
      ).toBe(true);
    },
  );

  it('keeps ordinary same-root multi-app mentions on normal chat task routing', async () => {
    const suffix = `${Date.now()}`;
    const { first, second } = await registerDiscussionBots(`plain-${suffix}`);
    const chatId = `debug_plain_multi_root_${suffix}`;
    const messageId = `om_plain_multi_root_${suffix}`;
    const text = '@_user_1 @_user_2 你们俩看一下这个问题';
    const extraMentions = [
      {
        key: '@_user_1',
        openId: first.feishuApp!.botOpenId,
        name: first.agent!.displayName,
      },
      {
        key: '@_user_2',
        openId: second.feishuApp!.botOpenId,
        name: second.agent!.displayName,
      },
    ];

    const [firstDelivery, secondDelivery] = await Promise.all([
      simulate(text, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: first.feishuApp!.id,
        extraMentions,
        eventId: `debug_plain_a_${suffix}`,
        messageId,
      }),
      simulate(text, OWNER_OPEN_ID, chatId, {
        chatType: 'group',
        feishuAppId: second.feishuApp!.id,
        extraMentions,
        eventId: `debug_plain_b_${suffix}`,
        messageId,
      }),
    ]);
    expect(firstDelivery.ok).toBe(true);
    expect(secondDelivery.ok).toBe(true);

    const discussion = await getLatestDiscussion({ chatId, rootThreadId: messageId });
    expect(discussion).toMatchObject({
      ok: true,
      discussion: null,
      participants: [],
      tasks: [],
    });
    const sessionTasks = await getSessionTasks({ chatId, messageId });
    expect(sessionTasks.ok).toBe(true);
    expect(sessionTasks.tasks).toHaveLength(2);
    expect(new Set(sessionTasks.tasks.map((task) => task.sessionId))).toEqual(
      new Set([sessionTasks.sessionId!]),
    );
    expect(new Set(sessionTasks.tasks.map((task) => task.feishuAppId))).toEqual(
      new Set([first.feishuApp!.id, second.feishuApp!.id]),
    );
    expect(sessionTasks.tasks.every((task) => task.taskType === 'chat_reply')).toBe(true);
    expect(
      sessionTasks.tasks.every((task) => ['queued', 'completed'].includes(task.status)),
    ).toBe(true);
  });

  it('preserves non-bot mentions in task goals created from group text', async () => {
    const chatId = `debug_mention_goal_${Date.now()}`;
    const result = await simulate(
      '创建一个文件 2.txt，完成之后把 @_user_2 叫起来干活，记得礼貌客气一点',
      OWNER_OPEN_ID,
      chatId,
      {
        chatType: 'group',
        mentionBot: true,
        extraMentions: [{ key: '@_user_2', openId: 'ou_tao', name: '陶克路' }],
      },
    );
    expect(result.ok).toBe(true);

    const latestTaskResult = await getLatestTask({ chatId });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task).toBeTruthy();

    const latestTask = latestTaskResult.task!;
    expect(latestTask.goal).toBe(
      '创建一个文件 2.txt，完成之后把 @陶克路 叫起来干活，记得礼貌客气一点',
    );
    expect(latestTask.status).toBe('queued');
  });

  it('inherits a quoted image attachment for a topic-start parent-only message', async () => {
    const chatId = `debug_referenced_image_root_${Date.now()}`;
    const referencedMessageId = `om_debug_ref_image_${Date.now()}`;
    const result = await simulate('分析一下引用图片', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      parentMessageId: referencedMessageId,
      referencedMessage: {
        messageId: referencedMessageId,
        messageType: 'image',
        content: { image_key: 'img_debug_ref_e2e' },
      },
    });
    expect(result.ok).toBe(true);

    const latestTaskResult = await getLatestTask({ chatId, goal: '分析一下引用图片' });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task).toBeTruthy();
    expect(latestTaskResult.task!.runtimeHint).toBeNull();
    expect(latestTaskResult.task!.goal).toBe('分析一下引用图片');
    expect(latestTaskResult.task!.status).toBe('queued');

    const sessionTasks = await getSessionTasks({ chatId });
    expect(sessionTasks.ok).toBe(true);
    expect(sessionTasks.tasks).toHaveLength(1);
    expect(sessionTasks.tasks[0].constraints).toMatchObject({
      imageAttachment: {
        imageKey: 'img_debug_ref_e2e',
        messageId: referencedMessageId,
      },
    });
  });

  it('inherits a quoted image attachment for a first-seen image-root topic', async () => {
    const chatId = `debug_referenced_image_topic_root_${Date.now()}`;
    const suffix = Date.now();
    const threadId = `omt_debug_ref_image_topic_${suffix}`;
    const referencedMessageId = `om_debug_ref_image_topic_${suffix}`;
    const result = await simulate('解读一下这个图片', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      threadId,
      rootMessageId: referencedMessageId,
      parentMessageId: referencedMessageId,
      referencedMessage: {
        messageId: referencedMessageId,
        messageType: 'image',
        content: { image_key: 'img_debug_ref_topic_e2e' },
      },
    });
    expect(result.ok).toBe(true);

    const sessionTasks = await getSessionTasks({ chatId });
    expect(sessionTasks.ok).toBe(true);
    expect(sessionTasks.tasks).toHaveLength(1);
    expect(sessionTasks.tasks[0].goal).toBe('解读一下这个图片');
    expect(sessionTasks.tasks[0].constraints).toMatchObject({
      imageAttachment: {
        imageKey: 'img_debug_ref_topic_e2e',
        messageId: referencedMessageId,
      },
    });
  });

  it('keeps a first-seen quoted-image topic on the current Feishu thread when the receive event omits thread_id', async () => {
    const chatId = `debug_referenced_image_current_thread_${Date.now()}`;
    const suffix = Date.now();
    const threadId = `omt_debug_current_thread_${suffix}`;
    const currentMessageId = `om_debug_current_thread_request_${suffix}`;
    const followupMessageId = `om_debug_current_thread_followup_${suffix}`;
    const referencedMessageId = `om_debug_current_thread_image_${suffix}`;

    const first = await simulate('解读一下这个图片', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      messageId: currentMessageId,
      rootMessageId: referencedMessageId,
      parentMessageId: referencedMessageId,
      referencedMessage: {
        messageId: referencedMessageId,
        messageType: 'image',
        content: { image_key: 'img_debug_ref_current_thread_e2e' },
      },
      referencedMessages: [
        {
          messageId: currentMessageId,
          messageType: 'text',
          content: { text: '解读一下这个图片' },
          threadId,
          rootMessageId: currentMessageId,
          parentMessageId: referencedMessageId,
        },
      ],
    });
    expect(first.ok).toBe(true);

    const followup = await simulate('你来评价一下', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      threadId,
      eventId: `debug_current_thread_followup_${suffix}`,
      messageId: followupMessageId,
    });
    expect(followup.ok).toBe(true);

    const sessionTasks = await getSessionTasks({ chatId });
    expect(sessionTasks.ok).toBe(true);
    expect(sessionTasks.tasks).toHaveLength(2);
    expect(new Set(sessionTasks.tasks.map((task) => task.sessionId))).toHaveLength(1);
    expect(sessionTasks.tasks.map((task) => task.goal).sort()).toEqual([
      '你来评价一下',
      '解读一下这个图片',
    ]);
    const firstTask = sessionTasks.tasks.find((task) => task.goal === '解读一下这个图片');
    expect(firstTask?.constraints).toMatchObject({
      imageAttachment: {
        imageKey: 'img_debug_ref_current_thread_e2e',
        messageId: referencedMessageId,
      },
    });
  });

  it('does not inherit established topic parent images for ordinary follow-ups', async () => {
    const chatId = `debug_referenced_image_followup_${Date.now()}`;
    const suffix = Date.now();
    const threadId = `omt_debug_topic_root_${suffix}`;
    const referencedMessageId = `om_debug_ref_image_${suffix}`;
    const first = await simulate('第一条先建立这个图片话题', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      threadId,
      rootMessageId: referencedMessageId,
      parentMessageId: referencedMessageId,
      referencedMessage: {
        messageId: referencedMessageId,
        messageType: 'image',
        content: { image_key: 'img_debug_ref_followup_e2e' },
      },
    });
    expect(first.ok).toBe(true);

    const result = await simulate('继续补充一下结论', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      threadId,
      rootMessageId: referencedMessageId,
      parentMessageId: referencedMessageId,
      referencedMessage: {
        messageId: referencedMessageId,
        messageType: 'image',
        content: { image_key: 'img_debug_ref_followup_e2e' },
      },
      eventId: `debug_followup_ref_${suffix}`,
      messageId: `om_debug_followup_ref_${suffix}`,
    });
    expect(result.ok).toBe(true);

    const latestTaskResult = await getLatestTask({ chatId, goal: '继续补充一下结论' });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task).toBeTruthy();
    expect(latestTaskResult.task!.runtimeHint).toBeNull();
    expect(latestTaskResult.task!.goal).toBe('继续补充一下结论');
    expect(latestTaskResult.task!.status).toBe('queued');

    const sessionTasks = await getSessionTasks({ chatId });
    expect(sessionTasks.ok).toBe(true);
    expect(sessionTasks.tasks).toHaveLength(2);
    const followupTask = sessionTasks.tasks.find((task) => task.goal === '继续补充一下结论');
    expect(followupTask).toBeTruthy();
    expect(followupTask!.constraints).not.toHaveProperty('imageAttachment');
  });

  it('recovers an explicitly requested image inside an established topic', async () => {
    const chatId = `debug_referenced_image_established_${Date.now()}`;
    const suffix = Date.now();
    const threadId = `omt_debug_established_image_${suffix}`;
    const referencedMessageId = `om_debug_established_image_${suffix}`;
    const first = await simulate('先建立这个图片话题', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      threadId,
      rootMessageId: referencedMessageId,
      parentMessageId: referencedMessageId,
      referencedMessage: {
        messageId: referencedMessageId,
        messageType: 'image',
        content: { image_key: 'img_debug_ref_established_e2e' },
      },
    });
    expect(first.ok).toBe(true);

    const result = await simulate('解读一下这个图片', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      threadId,
      rootMessageId: referencedMessageId,
      parentMessageId: referencedMessageId,
      referencedMessage: {
        messageId: referencedMessageId,
        messageType: 'image',
        content: { image_key: 'img_debug_ref_established_e2e' },
      },
      eventId: `debug_established_ref_${suffix}`,
      messageId: `om_debug_established_ref_${suffix}`,
    });
    expect(result.ok).toBe(true);

    const sessionTasks = await getSessionTasks({ chatId });
    expect(sessionTasks.ok).toBe(true);
    expect(sessionTasks.tasks).toHaveLength(2);
    const followupTask = sessionTasks.tasks.find((task) => task.goal === '解读一下这个图片');
    expect(followupTask).toBeTruthy();
    expect(followupTask!.constraints).toMatchObject({
      imageAttachment: {
        imageKey: 'img_debug_ref_established_e2e',
        messageId: referencedMessageId,
      },
    });
  });

  it('does not add upstream referenced message chain to topic task goals', async () => {
    const chatId = `debug_referenced_chain_${Date.now()}`;
    const suffix = Date.now();
    const message4 = `om_debug_ref_chain_4_${suffix}`;
    const message3 = `om_debug_ref_chain_3_${suffix}`;
    const message2 = `om_debug_ref_chain_2_${suffix}`;
    const message1 = `om_debug_ref_chain_1_${suffix}`;
    const threadParentMessage = `om_debug_thread_parent_${suffix}`;
    const result = await simulate('总结这条引用链', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      rootMessageId: `om_debug_topic_root_${suffix}`,
      parentMessageId: threadParentMessage,
      referenceMessageId: message4,
      referencedMessages: [
        {
          messageId: message4,
          messageType: 'text',
          content: { text: '消息 4 引用消息 3' },
          parentMessageId: message3,
        },
        {
          messageId: message3,
          messageType: 'text',
          content: { text: '消息 3 引用消息 2' },
          parentMessageId: message2,
        },
        {
          messageId: message2,
          messageType: 'text',
          content: { text: '消息 2 引用消息 1' },
          parentMessageId: message1,
        },
        {
          messageId: message1,
          messageType: 'text',
          content: { text: '消息 1 是源消息' },
        },
      ],
    });
    expect(result.ok).toBe(true);

    const latestTaskResult = await getLatestTask({ chatId });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task).toBeTruthy();
    expect(latestTaskResult.task!.goal).toBe('总结这条引用链');
    expect(latestTaskResult.task!.goal).not.toContain(`[Referenced Feishu message: ${message4}]`);
    expect(latestTaskResult.task!.goal).not.toContain(`[Referenced Feishu message: ${message3}]`);
    expect(latestTaskResult.task!.goal).not.toContain(`[Referenced Feishu message: ${message2}]`);
    expect(latestTaskResult.task!.goal).not.toContain(`[Referenced Feishu message: ${message1}]`);
    expect(latestTaskResult.task!.goal).not.toContain(
      `[Referenced Feishu message: ${threadParentMessage}]`,
    );
    expect(latestTaskResult.task!.goal).not.toContain('消息 1 是源消息');
    expect(latestTaskResult.task!.status).toBe('queued');
  });

  it('creates follow-up topic tasks under the existing group topic session', async () => {
    const chatId = `debug_topic_serial_${Date.now()}`;
    const firstGoal = `verify topic session first task ${Date.now()}`;
    const firstResult = await simulate(firstGoal, OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
    });
    expect(firstResult.ok).toBe(true);
    expect(firstResult.messageId).toBeTruthy();

    const firstTaskResult = await getLatestTask({ goal: firstGoal });
    expect(firstTaskResult.ok).toBe(true);
    expect(firstTaskResult.task).toBeTruthy();
    const firstTask = firstTaskResult.task!;

    const secondGoal = `verify topic session second task ${Date.now()}`;
    const secondResult = await simulate(
      secondGoal,
      OWNER_OPEN_ID,
      chatId,
      {
        chatType: 'group',
        mentionBot: true,
        threadId: firstResult.messageId,
      },
    );
    expect(secondResult.ok).toBe(true);

    const secondTaskResult = await getLatestTask({ goal: secondGoal });
    expect(secondTaskResult.ok).toBe(true);
    expect(secondTaskResult.task).toBeTruthy();
    const secondTask = secondTaskResult.task!;

    expect(secondTask.id).not.toBe(firstTask.id);
    expect(secondTask.sessionId).toBe(firstTask.sessionId);
    expect(secondTask.status).toBe('queued');
  });
});

describe('E2E: agent identity routing', () => {
  it('routes legacy debug traffic to the built-in open-claude-tag agent', async () => {
    const chatId = `debug_agent_legacy_${Date.now()}`;
    const result = await simulate('hello legacy agent route', OWNER_OPEN_ID, chatId, {
      expectedAgentHandle: 'open-claude-tag',
    });

    expect(result.ok).toBe(true);
    expect(result.agent?.handle).toBe('open-claude-tag');

    const latestTaskResult = await getLatestTask({ chatId });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task?.agentId).toBe(result.agent?.id);
  });

  it('routes legacy non-persisted non-default tenant traffic to the default built-in agent', async () => {
    const chatId = `debug_agent_tenant_${Date.now()}`;
    const result = await simulate('hello tenant-scoped legacy agent route', OWNER_OPEN_ID, chatId, {
      tenantKey: 'tenant_live_feishu_e2e',
      expectedAgentHandle: 'open-claude-tag',
    });

    expect(result.ok).toBe(true);
    expect(result.agent?.handle).toBe('open-claude-tag');

    const latestTaskResult = await getLatestTask({ chatId });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task?.agentId).toBe(result.agent?.id);
  });

  it('supports virtual handle routing through debug simulate', async () => {
    const chatId = `debug_agent_virtual_${Date.now()}`;
    const result = await simulate('handle this via virtual route', OWNER_OPEN_ID, chatId, {
      virtualAgentHandle: 'open-claude-tag',
      expectedAgentHandle: 'open-claude-tag',
    });

    expect(result.ok).toBe(true);
    expect(result.agent?.handle).toBe('open-claude-tag');
  });

  it('fails safely when a debug Feishu app context is missing', async () => {
    const chatId = `debug_agent_missing_app_${Date.now()}`;
    const result = await simulate('hello missing app', OWNER_OPEN_ID, chatId, {
      feishuAppId: 'missing_feishu_app_context',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Feishu app context not found');
  });
});

describe('E2E: task tracking and board commands', () => {
  it('creates a Feishu Task tracking link when tracking is enabled', async () => {
    if (process.env.OPEN_TAG_FEISHU_TASK_TRACKING !== 'enabled') {
      return;
    }

    const chatId = `debug_feishu_task_tracking_${Date.now()}`;
    const goal = `verify feishu task tracking ${Date.now()}`;
    const result = await simulate(goal, OWNER_OPEN_ID, chatId);
    expect(result.ok).toBe(true);

    const latestTaskResult = await getLatestTask({ chatId });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task).toBeTruthy();

    const linkResult = await getTaskLink(latestTaskResult.task!.id);
    expect(linkResult.ok).toBe(true);
    expect(linkResult.link).toEqual(
      expect.objectContaining({
        taskId: latestTaskResult.task!.id,
        feishuTaskGuid: expect.stringContaining('debug_task_'),
        feishuTaskUrl: expect.stringContaining('https://applink.feishu.cn/client/todo/detail'),
        sourceMessageId: expect.stringContaining('om_debug_'),
        sourceTopicUrl: expect.stringContaining('https://applink.feishu.cn/client/thread/open'),
        lastSyncedStatus: 'todo',
        lastSyncError: null,
      }),
    );

    const sent = await getSentMessages({ chatId, msgType: 'text', limit: 5 });
    expect(
      sent.messages.some((message) =>
        message.text?.includes('Feishu task: https://applink.feishu.cn/client/todo/detail'),
      ),
    ).toBe(true);
  });

  it('keeps bot-mentioned chat local-only in Feishu Task tracking', async () => {
    if (process.env.OPEN_TAG_FEISHU_TASK_TRACKING !== 'enabled') {
      return;
    }

    const chatId = `debug_feishu_task_chat_only_${Date.now()}`;
    const result = await simulate(`你好 ${Date.now()}`, NON_OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
    });
    expect(result.ok).toBe(true);

    const latestTaskResult = await getLatestTask({ chatId });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task).toBeTruthy();

    const latestTask = latestTaskResult.task!;
    expect(latestTask.taskType).toBe('chat_reply');
    expect(latestTask.status).toBe('queued');

    const linkResult = await getTaskLink(latestTask.id);
    expect(linkResult.ok).toBe(true);
    expect(linkResult.link).toBeNull();

    const sent = await getSentMessages({ chatId, msgType: 'text', limit: 5 });
    expect(
      sent.messages.some((message) =>
        message.text?.includes('Feishu task: https://applink.feishu.cn/client/todo/detail'),
      ),
    ).toBe(false);
  });

  it('creates a Feishu Task for plain-language chat work when tracking is enabled', async () => {
    if (process.env.OPEN_TAG_FEISHU_TASK_TRACKING !== 'enabled') {
      return;
    }

    const chatId = `debug_feishu_task_plain_work_${Date.now()}`;
    const result = await simulate('创建一个文件 2.txt，写入内容 hello world', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
    });
    expect(result.ok).toBe(true);

    const latestTaskResult = await getLatestTask({ chatId });
    expect(latestTaskResult.task).toBeTruthy();
    expect(latestTaskResult.task!.taskType).toBe('chat_reply');

    const linkResult = await getTaskLink(latestTaskResult.task!.id);
    expect(linkResult.link).toEqual(
      expect.objectContaining({
        taskId: latestTaskResult.task!.id,
        feishuTaskGuid: expect.stringContaining('debug_task_'),
        feishuTaskUrl: expect.stringContaining('https://applink.feishu.cn/client/todo/detail'),
        lastSyncedStatus: 'todo',
        lastSyncError: null,
      }),
    );
  });

  it('creates the first Feishu Task when the third topic message becomes work', async () => {
    if (process.env.OPEN_TAG_FEISHU_TASK_TRACKING !== 'enabled') {
      return;
    }

    const chatId = `debug_feishu_task_late_topic_work_${Date.now()}`;
    const firstResult = await simulate('你好', NON_OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
    });
    expect(firstResult.ok).toBe(true);
    expect(firstResult.messageId).toBeTruthy();

    const firstTaskResult = await getLatestTask({ chatId });
    expect(firstTaskResult.task).toBeTruthy();
    const firstLinkResult = await getTaskLink(firstTaskResult.task!.id);
    expect(firstLinkResult.link).toBeNull();

    const secondResult = await simulate('先看看这个话题上下文', NON_OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      threadId: firstResult.messageId,
    });
    expect(secondResult.ok).toBe(true);

    const secondTaskResult = await getLatestTask({ chatId });
    expect(secondTaskResult.task).toBeTruthy();
    const secondLinkResult = await getTaskLink(secondTaskResult.task!.id);
    expect(secondLinkResult.link).toBeNull();

    const thirdResult = await simulate(
      '调研一下这个方案并总结优缺点',
      NON_OWNER_OPEN_ID,
      chatId,
      {
        chatType: 'group',
        mentionBot: true,
        threadId: firstResult.messageId,
      },
    );
    expect(thirdResult.ok).toBe(true);

    const thirdTaskResult = await getLatestTask({ chatId });
    expect(thirdTaskResult.task).toBeTruthy();
    expect(thirdTaskResult.task!.id).not.toBe(secondTaskResult.task!.id);

    const thirdLinkResult = await getTaskLink(thirdTaskResult.task!.id);
    expect(thirdLinkResult.link).toEqual(
      expect.objectContaining({
        taskId: thirdTaskResult.task!.id,
        feishuTaskGuid: expect.stringContaining('debug_task_'),
        feishuTaskUrl: expect.stringContaining('https://applink.feishu.cn/client/todo/detail'),
        lastSyncedStatus: 'todo',
        lastSyncError: null,
      }),
    );
  });

  it('reuses one Feishu Task tracking item for follow-ups in the same topic', async () => {
    if (process.env.OPEN_TAG_FEISHU_TASK_TRACKING !== 'enabled') {
      return;
    }

    const chatId = `debug_feishu_task_topic_dedup_${Date.now()}`;
    const firstResult = await simulate(
      `verify feishu topic task dedup ${Date.now()}`,
      OWNER_OPEN_ID,
      chatId,
    );
    expect(firstResult.ok).toBe(true);
    expect(firstResult.messageId).toBeTruthy();

    const firstTaskResult = await getLatestTask({ chatId });
    expect(firstTaskResult.task).toBeTruthy();
    const firstLinkResult = await getTaskLink(firstTaskResult.task!.id);
    expect(firstLinkResult.link?.feishuTaskGuid).toBeTruthy();

    const secondResult = await simulate(
      'verify follow-up in the same topic',
      OWNER_OPEN_ID,
      chatId,
      { threadId: firstResult.messageId },
    );
    expect(secondResult.ok).toBe(true);

    const secondTaskResult = await getLatestTask({ chatId });
    expect(secondTaskResult.task).toBeTruthy();
    expect(secondTaskResult.task!.id).not.toBe(firstTaskResult.task!.id);

    const secondLinkResult = await getTaskLink(secondTaskResult.task!.id);
    expect(secondLinkResult.link).toEqual(
      expect.objectContaining({
        taskId: secondTaskResult.task!.id,
        feishuTaskGuid: firstLinkResult.link!.feishuTaskGuid,
        feishuTaskUrl: firstLinkResult.link!.feishuTaskUrl,
        lastSyncedStatus: 'todo',
        lastSyncError: null,
      }),
    );

    const sent = await getSentMessages({ chatId, msgType: 'text', limit: 20 });
    const taskLinkMessages = sent.messages.filter((message) =>
      message.text?.includes('Feishu task: https://applink.feishu.cn/client/todo/detail'),
    );
    expect(taskLinkMessages).toHaveLength(1);
  });

  it('reuses the Feishu Task when a topic follow-up replies to the completion notification', async () => {
    if (process.env.OPEN_TAG_FEISHU_TASK_TRACKING !== 'enabled') {
      return;
    }

    const chatId = `debug_feishu_task_completion_reply_${Date.now()}`;
    const firstResult = await simulate(
      `verify completion reply task dedup ${Date.now()}`,
      OWNER_OPEN_ID,
      chatId,
      { chatType: 'group', mentionBot: true },
    );
    expect(firstResult.ok).toBe(true);

    const firstTaskResult = await getLatestTask({ chatId });
    expect(firstTaskResult.task).toBeTruthy();
    const firstTask = firstTaskResult.task!;
    const firstLinkResult = await getTaskLink(firstTask.id);
    expect(firstLinkResult.link?.feishuTaskGuid).toBeTruthy();

    const feedbackResult = await sendTaskFeedback({
      taskId: firstTask.id,
      status: 'completed',
      resultText: 'debug completion output',
    });
    expect(feedbackResult.ok).toBe(true);
    expect(feedbackResult.completionMessageId).toBeTruthy();

    const secondResult = await simulate(
      'verify follow-up after completion notification',
      OWNER_OPEN_ID,
      chatId,
      {
        chatType: 'group',
        mentionBot: true,
        parentMessageId: feedbackResult.completionMessageId!,
      },
    );
    expect(secondResult.ok).toBe(true);

    const secondTaskResult = await getLatestTask({ chatId });
    expect(secondTaskResult.task).toBeTruthy();
    const secondTask = secondTaskResult.task!;
    expect(secondTask.id).not.toBe(firstTask.id);
    expect(secondTask.sessionId).toBe(firstTask.sessionId);

    const secondLinkResult = await getTaskLink(secondTask.id);
    expect(secondLinkResult.link).toEqual(
      expect.objectContaining({
        taskId: secondTask.id,
        feishuTaskGuid: firstLinkResult.link!.feishuTaskGuid,
        feishuTaskUrl: firstLinkResult.link!.feishuTaskUrl,
        lastSyncedStatus: 'todo',
        lastSyncError: null,
      }),
    );

    const sent = await getSentMessages({ chatId, msgType: 'text', limit: 30 });
    const taskLinkMessages = sent.messages.filter((message) =>
      message.text?.includes('Feishu task: https://applink.feishu.cn/client/todo/detail'),
    );
    expect(taskLinkMessages).toHaveLength(1);
  });

  it('/chat init creates and binds a chat task board when tracking is enabled', async () => {
    if (process.env.OPEN_TAG_FEISHU_TASK_TRACKING !== 'enabled') {
      return;
    }

    const chatId = `debug_init_task_board_${Date.now()}`;
    const initResult = await simulate('/chat init', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
    });
    expect(initResult.ok).toBe(true);

    const scopeId = chatTaskScopeId(chatId);
    const spaceResult = await getTaskTrackingSpace({ scopeType: 'chat', scopeId });
    expect(spaceResult.ok).toBe(true);
    expect(spaceResult.space).toEqual(
      expect.objectContaining({
        scopeType: 'chat',
        scopeId,
        tasklistGuid: 'debug_tasklist_001',
        statusFieldGuid: 'debug_status_field_001',
      }),
    );
    expect(spaceResult.space?.statusOptions).toEqual(
      expect.objectContaining({
        todo: 'debug_option_todo',
        'in-progress': 'debug_option_in-progress',
        'to-clarify': 'debug_option_to-clarify',
        review: 'debug_option_review',
        completed: 'debug_option_completed',
      }),
    );

    const sent = await getSentMessages({ chatId, msgType: 'text', limit: 5 });
    expect(
      sent.messages.some((message) => message.text?.includes('GUID: debug_tasklist_001')),
    ).toBe(true);
  });

  it('/add-bot shares an initialized chat task board with another bot', async () => {
    if (process.env.OPEN_TAG_FEISHU_TASK_TRACKING !== 'enabled') {
      return;
    }

    const chatId = `debug_add_bot_task_board_${Date.now()}`;
    const newBotOpenId = `ou_debug_new_bot_${Date.now()}`;
    const initResult = await simulate('/chat init', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
    });
    expect(initResult.ok).toBe(true);

    const addResult = await simulate('/add-bot', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      extraMentions: [{ key: '@_user_2', openId: newBotOpenId, name: 'Debug New Bot' }],
    });
    expect(addResult.ok).toBe(true);

    const groupSent = await getSentMessages({ chatId, msgType: 'text', limit: 5 });
    expect(
      groupSent.messages.some((message) =>
        message.text?.includes('Bot added to this chat task board.'),
      ),
    ).toBe(true);

    const configurationMessage = groupSent.messages.find((message) =>
      message.text?.includes(
        `<at user_id="${newBotOpenId}">Debug New Bot</at> /configure-tasklist `,
      ),
    );
    expect(configurationMessage).toBeDefined();
    const encodedPayload = configurationMessage?.text?.match(/\/configure-tasklist\s+(\S+)/)?.[1];
    expect(encodedPayload).toBeTruthy();

    const scopeId = chatTaskScopeId(chatId);
    const deleteResult = await deleteTaskTrackingSpace({ scopeType: 'chat', scopeId });
    expect(deleteResult).toEqual({ ok: true, deletedCount: 1 });
    const emptyTargetSpace = await getTaskTrackingSpace({ scopeType: 'chat', scopeId });
    expect(emptyTargetSpace.space).toBeNull();

    const configureResult = await simulate(
      `/configure-tasklist ${encodedPayload}`,
      `ou_debug_source_bot_${Date.now()}`,
      chatId,
      {
        chatType: 'group',
        mentionBot: true,
        senderType: 'app',
        threadId: 'omt_debug_configure_tasklist',
      },
    );
    expect(configureResult.ok).toBe(true);

    const afterConfigureSent = await getSentMessages({ chatId, msgType: 'text', limit: 10 });
    expect(
      afterConfigureSent.messages.some((message) =>
        message.text?.includes('Task board configuration applied.'),
      ),
    ).toBe(true);

    const spaceResult = await getTaskTrackingSpace({ scopeType: 'chat', scopeId });
    expect(spaceResult.space).toMatchObject({
      scopeType: 'chat',
      scopeId,
      tasklistGuid: 'debug_tasklist_001',
      statusFieldGuid: 'debug_status_field_001',
    });
    expect(spaceResult.space?.sections).toEqual(
      expect.objectContaining({
        todo: 'debug_section_todo',
        'in-progress': 'debug_section_in-progress',
        'to-clarify': 'debug_section_to-clarify',
        review: 'debug_section_review',
        completed: 'debug_section_completed',
      }),
    );
  });

  it('/add-bot rejects a human mention target', async () => {
    if (process.env.OPEN_TAG_FEISHU_TASK_TRACKING !== 'enabled') {
      return;
    }

    const chatId = `debug_add_bot_human_${Date.now()}`;
    const initResult = await simulate('/chat init', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
    });
    expect(initResult.ok).toBe(true);

    const addResult = await simulate('/add-bot', OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
      extraMentions: [{ key: '@_user_2', openId: 'ou_debug_member_001', name: 'Debug Member 1' }],
    });
    expect(addResult.ok).toBe(true);

    const groupSent = await getSentMessages({ chatId, msgType: 'text', limit: 10 });
    expect(
      groupSent.messages.some((message) =>
        message.text?.includes('Command failed: /add-bot target must be a bot mention'),
      ),
    ).toBe(true);
    expect(
      groupSent.messages.some((message) =>
        message.text?.includes(
          '<at user_id="ou_debug_member_001">Debug Member 1</at> /configure-tasklist ',
        ),
      ),
    ).toBe(false);
  });

});

describe('E2E: /schedule command', () => {
  it('owner can schedule a future task', async () => {
    const result = await simulate('/schedule 30分钟后 implement test feature', OWNER_OPEN_ID);
    expect(result.ok).toBe(true);
  });

  it('non-owner /schedule is rejected internally', async () => {
    const result = await simulate('/schedule 1小时后 do something', NON_OWNER_OPEN_ID);
    expect(result.ok).toBe(true); // event accepted, command rejected internally
  });

  it('invalid time format returns ok (error handled gracefully)', async () => {
    const result = await simulate('/schedule invalid-time-format do something', OWNER_OPEN_ID);
    expect(result.ok).toBe(true);
  });
});

describe('E2E: /status command', () => {
  it('any user can check status', async () => {
    const result = await simulate('/status', NON_OWNER_OPEN_ID);
    expect(result.ok).toBe(true);
  });
});

describe('E2E: /help command', () => {
  it('/help is accepted as a slash command', async () => {
    const result = await simulate('/help', NON_OWNER_OPEN_ID);
    expect(result.ok).toBe(true);
    expect(result.eventId).toBeTruthy();
  });

  it('/session --help is accepted', async () => {
    const result = await simulate('/session --help', NON_OWNER_OPEN_ID);
    expect(result.ok).toBe(true);
  });

});

describe('E2E: bilingual direct replies', () => {
  it('returns Chinese validation text for invalid /schedule', async () => {
    const chatId = `debug_schedule_invalid_zh_${Date.now()}`;
    const result = await simulatePost(
      '/schedule invalid-time-format do something',
      OWNER_OPEN_ID,
      chatId,
      'zh_cn',
    );
    expect(result.ok).toBe(true);

    const sent = await getSentMessages({ chatId });
    expect(sent.ok).toBe(true);
    expect(sent.messages[0]?.text).toContain('无法解析时间表达式');
  });
});

describe('E2E: /session worktree subcommands', () => {
  it('owner can list worktree sessions', async () => {
    const chatId = `debug_session_worktrees_${Date.now()}`;
    const result = await simulate('/session worktrees', OWNER_OPEN_ID, chatId);
    expect(result.ok).toBe(true);

    const sent = await getSentMessages({ chatId, msgType: 'text', limit: 5 });
    expect(sent.messages.some((message) => message.text?.includes('Permission denied'))).toBe(
      false,
    );
  });

  it('non-owner /session worktrees is denied at subcommand level', async () => {
    const chatId = `debug_session_worktrees_denied_${Date.now()}`;
    const result = await simulate('/session worktrees', NON_OWNER_OPEN_ID, chatId);
    expect(result.ok).toBe(true); // event accepted, subcommand denied internally

    const sent = await getSentMessages({ chatId, msgType: 'text', limit: 5 });
    expect(
      sent.messages.some((message) => message.text?.includes('Permission denied')),
    ).toBe(true);
  });

  it('non-owner /session clean is denied at subcommand level', async () => {
    const chatId = `debug_session_clean_denied_${Date.now()}`;
    const result = await simulate('/session clean', NON_OWNER_OPEN_ID, chatId);
    expect(result.ok).toBe(true);

    const sent = await getSentMessages({ chatId, msgType: 'text', limit: 5 });
    expect(
      sent.messages.some((message) => message.text?.includes('Permission denied')),
    ).toBe(true);
  });

  it('non-owner /session list stays open', async () => {
    const chatId = `debug_session_list_open_${Date.now()}`;
    const result = await simulate('/session list', NON_OWNER_OPEN_ID, chatId);
    expect(result.ok).toBe(true);

    const sent = await getSentMessages({ chatId, msgType: 'text', limit: 5 });
    expect(sent.messages.some((message) => message.text?.includes('Permission denied'))).toBe(
      false,
    );
  });

  it('/session --help is accepted by anyone', async () => {
    const result = await simulate('/session --help', NON_OWNER_OPEN_ID);
    expect(result.ok).toBe(true);
  });
});

describe('E2E: removed slash commands degrade to plain messages', () => {
  it.each(['/sessions', '/use codex do something', '/approve 1', '/reject 1', '/init', '/ping'])(
    '%s is no longer parsed as a command',
    async (text) => {
      // simulate() always sets skipTaskExecution, so the degraded plain-text
      // message creates a task without running a runtime.
      const chatId = `debug_removed_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await simulate(text, OWNER_OPEN_ID, chatId);
      expect(result.ok).toBe(true);

      // No slash-command handling artifacts: no usage text, no permission
      // denial, no "unknown command" reply — the text went through normal
      // message intake instead.
      const sent = await getSentMessages({ chatId, msgType: 'text', limit: 10 });
      for (const marker of ['Usage:', 'Permission denied', 'Unknown command', '用法：', '权限不足']) {
        expect(
          sent.messages.some((message) => message.text?.includes(marker)),
          `expected no "${marker}" reply for ${text}`,
        ).toBe(false);
      }
    },
  );
});

describe('E2E: health check', () => {
  it('API server is running and DB is connected', async () => {
    const health = await getHealth();
    expect(health.status).toBe('ok');
    expect(health.db).toBe('connected');
  });
});

describe('E2E: Feishu webhook endpoint', () => {
  it('rejects stale signed webhook deliveries before dispatch', async () => {
    if (!process.env.FEISHU_ENCRYPT_KEY) {
      return;
    }
    const token = getWebhookVerificationToken();
    if (!token) {
      return;
    }

    const payload = {
      schema: '2.0',
      header: {
        event_id: `evt_stale_webhook_${Date.now()}`,
        event_type: 'im.message.receive_v1',
        app_id: 'cli_stale_test',
        token,
        tenant_key: DEBUG_TENANT_KEY,
      },
      event: {},
    };
    const response = await postFeishuWebhook(payload, { stale: true });

    expect(response.status).toBe(401);
    expect(response.text).toContain('Stale signature');
  });

  it('rejects oversized chunked webhook bodies while streaming', async () => {
    const body = JSON.stringify({
      header: {
        event_type: 'im.message.receive_v1',
      },
      event: {
        text: 'x'.repeat(FEISHU_WEBHOOK_MAX_BODY_BYTES + 1),
      },
    });

    const response = await postChunkedWebhookBody(body);

    expect(response.status).toBe(413);
  });

  it('accepts signed message webhooks through the real endpoint when webhook access is enabled', async () => {
    const token = getWebhookVerificationToken();
    if (!token) {
      return;
    }

    const health = await getHealth();
    const webhookApp = health.feishu?.apps?.find((appInfo) => appInfo.eventMode === 'webhook');
    const appId = webhookApp?.appId ?? health.feishu?.apps?.[0]?.appId;
    if (!appId) {
      return;
    }

    const chatId = `debug_real_webhook_${Date.now()}`;
    const messageId = `om_real_webhook_${Date.now()}`;
    const eventId = `evt_real_webhook_${Date.now()}`;
    const goal = `real webhook task ${Date.now()}`;
    const payload = {
      schema: '2.0',
      header: {
        event_id: eventId,
        event_type: 'im.message.receive_v1',
        app_id: appId,
        token,
        tenant_key: DEBUG_TENANT_KEY,
      },
      event: {
        message: {
          message_id: messageId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: `/dev ${goal}` }),
          create_time: String(Date.now()),
        },
        sender: {
          sender_id: {
            open_id: OWNER_OPEN_ID,
            union_id: '',
            user_id: '',
          },
          sender_type: 'user',
          tenant_key: DEBUG_TENANT_KEY,
        },
      },
    };

    const response = await postFeishuWebhook(payload);
    if (health.feishu?.access === 'disabled') {
      expect(response.status).toBe(503);
      expect(response.text).toContain('Feishu access is disabled');
      return;
    }
    if (!webhookApp) {
      expect(response.status).toBe(409);
      expect(response.text).toContain('webhook mode');
      return;
    }

    expect(response.status).toBe(200);
    expect(response.text).toContain('"code":0');

    const taskResult = await getLatestTask({ goal });
    expect(taskResult.ok).toBe(true);
    expect(taskResult.task).toMatchObject({
      goal,
      status: 'queued',
    });

    const replayResponse = await postFeishuWebhook(payload);
    expect(replayResponse.status).toBe(409);
  });
});

describe('E2E: group mention gate', () => {
  it('does not create tasks for unmentioned group thread replies', async () => {
    const cases: Array<{
      chatId: string;
      threadId?: string;
      rootMessageId?: string;
      parentMessageId?: string;
    }> = [
      { chatId: `debug_no_mention_thread_${Date.now()}`, threadId: 'omt_debug_no_mention' },
      { chatId: `debug_no_mention_root_${Date.now()}`, rootMessageId: 'om_debug_root' },
      { chatId: `debug_no_mention_parent_${Date.now()}`, parentMessageId: 'om_debug_parent' },
    ];

    for (const { chatId, ...threadOptions } of cases) {
      const result = await simulate(
        'thread follow-up without bot mention',
        NON_OWNER_OPEN_ID,
        chatId,
        {
          chatType: 'group',
          ...threadOptions,
        },
      );
      expect(result.ok).toBe(true);

      const latestTaskResult = await getLatestTask({ chatId });
      expect(latestTaskResult.ok).toBe(true);
      expect(latestTaskResult.task).toBeNull();
    }
  });
});

describe('E2E: task card actions', () => {
  it('retry action creates a new child task in the same session', async () => {
    const chatId = `debug_card_retry_${Date.now()}`;
    const goal = `write a callback retry test ${Date.now()}`;
    const createResult = await simulate(goal, OWNER_OPEN_ID, chatId);
    expect(createResult.ok).toBe(true);

    const originalTaskResult = await getLatestTask({ goal });
    expect(originalTaskResult.ok).toBe(true);
    expect(originalTaskResult.task).toBeTruthy();

    const originalTask = originalTaskResult.task!;
    const statusResult = await setTaskStatus(originalTask.id, 'failed');
    expect(statusResult.ok).toBe(true);

    const actionResult = await simulateCardAction(originalTask.id, TASK_CARD_ACTION_RETRY);
    expect(actionResult.ok).toBe(true);
    expect(actionResult.response?.toast?.type).toBe('success');

    const latestTaskResult = await getLatestTask({ goal });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task).toBeTruthy();

    const latestTask = latestTaskResult.task!;
    expect(latestTask.id).not.toBe(originalTask.id);
    expect(latestTask.parentTaskId).toBe(originalTask.id);
    expect(latestTask.sessionId).toBe(originalTask.sessionId);
    expect(latestTask.taskType).toBe(originalTask.taskType);
    expect(latestTask.goal).toBe(originalTask.goal);
    expect(latestTask.runtimeHint).toBe(originalTask.runtimeHint);
    expect(latestTask.status).toBe('queued');
  });

  it('rejects retry actions from a different Feishu operator', async () => {
    const chatId = `debug_card_reject_operator_${Date.now()}`;
    const goal = `reject callback retry intruder ${Date.now()}`;
    const createResult = await simulate(goal, OWNER_OPEN_ID, chatId);
    expect(createResult.ok).toBe(true);

    const originalTaskResult = await getLatestTask({ goal });
    expect(originalTaskResult.ok).toBe(true);
    expect(originalTaskResult.task).toBeTruthy();

    const originalTask = originalTaskResult.task!;
    const statusResult = await setTaskStatus(originalTask.id, 'failed');
    expect(statusResult.ok).toBe(true);

    const actionResult = await simulateCardAction(
      originalTask.id,
      TASK_CARD_ACTION_RETRY,
      undefined,
      { openId: NON_OWNER_OPEN_ID },
    );
    expect(actionResult.ok).toBe(true);
    expect(actionResult.response?.toast?.type).toBe('warning');
    expect(actionResult.response?.toast?.content).toContain('original requester');

    const latestTaskResult = await getLatestTask({ goal });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task?.id).toBe(originalTask.id);
  });

  it('run with codex action forces codex on the new task', async () => {
    const chatId = `debug_card_codex_${Date.now()}`;
    const goal = `write a callback codex test ${Date.now()}`;
    const createResult = await simulate(goal, OWNER_OPEN_ID, chatId);
    expect(createResult.ok).toBe(true);

    const originalTaskResult = await getLatestTask({ goal });
    expect(originalTaskResult.ok).toBe(true);
    expect(originalTaskResult.task).toBeTruthy();

    const originalTask = originalTaskResult.task!;
    const statusResult = await setTaskStatus(originalTask.id, 'completed');
    expect(statusResult.ok).toBe(true);

    const actionResult = await simulateCardAction(
      originalTask.id,
      TASK_CARD_ACTION_RETRY_RUNTIME,
      'codex',
    );
    expect(actionResult.ok).toBe(true);
    expect(actionResult.response?.toast?.type).toBe('success');

    const latestTaskResult = await getLatestTask({ goal });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task).toBeTruthy();

    const latestTask = latestTaskResult.task!;
    expect(latestTask.id).not.toBe(originalTask.id);
    expect(latestTask.parentTaskId).toBe(originalTask.id);
    expect(latestTask.taskType).toBe(originalTask.taskType);
    expect(latestTask.runtimeHint).toBe('codex');
    expect(latestTask.status).toBe('queued');
  });
});

describe('E2E: task feedback threading', () => {
  it('threads completion notifications under the ack card for group root tasks', async () => {
    const chatId = `debug_group_feedback_${Date.now()}`;
    const goal = `verify completion threading ${Date.now()}`;
    const createResult = await simulate(goal, OWNER_OPEN_ID, chatId, {
      chatType: 'group',
      mentionBot: true,
    });
    expect(createResult.ok).toBe(true);

    const latestTaskResult = await getLatestTask({ chatId });
    expect(latestTaskResult.ok).toBe(true);
    expect(latestTaskResult.task).toBeTruthy();

    const task = latestTaskResult.task!;
    expect(task.feedbackMessageId).toBeTruthy();

    const feedbackResult = await sendTaskFeedback({
      taskId: task.id,
      status: 'completed',
      resultText: 'debug completion output',
    });
    expect(feedbackResult.ok).toBe(true);
    expect(feedbackResult.replyTarget).toBe(task.feedbackMessageId);

    const sent = await getSentMessages({ chatId, msgType: 'text', limit: 1 });
    expect(sent.ok).toBe(true);
    expect(sent.messages[0]?.text).toContain('Task complete');
  });
});
