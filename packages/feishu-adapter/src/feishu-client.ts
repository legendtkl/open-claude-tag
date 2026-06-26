import { randomUUID } from 'node:crypto';
import { createLogger } from '@open-tag/observability';
import type { InteractiveCard } from './card-builder.js';
import type { PostContent } from './markdown-to-post.js';
import type { FeishuMessageDetail } from './referenced-message.js';

export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  maxRequestAttempts?: number;
  retryDelayMs?: number;
  /** Per-attempt fetch timeout; also bounds response body reads. */
  requestTimeoutMs?: number;
}

export interface SendMessageResult {
  messageId: string;
}

export interface SendMessageOptions {
  uuid?: string;
}

export interface FeishuDocumentCommentReplyResult {
  replyId: string;
}

export interface FeishuDocumentCommentCreateResult {
  commentId: string;
  replyId?: string;
}

export interface FeishuDocumentCommentReplyReactionInput {
  fileToken: string;
  fileType: string;
  replyId: string;
  reactionType: string;
  action?: 'add' | 'delete';
}

export interface FeishuDocumentCommentCreateElement {
  type: 'text' | 'mention_user';
  text?: string;
  mentionUser?: string;
}

interface FeishuDocumentCommentCreateApiElement {
  type: 'text' | 'mention_user';
  text?: string;
  mention_user?: string;
}

export interface FeishuDocumentCommentContentElement {
  type?: string;
  textRun?: {
    text?: string;
  } | null;
  person?: {
    userId?: string;
  } | null;
}

export interface FeishuDocumentCommentReply {
  replyId: string;
  userId?: string;
  createTime?: number;
  updateTime?: number;
  content?: {
    elements?: FeishuDocumentCommentContentElement[];
  };
}

export interface FeishuDocumentComment {
  commentId: string;
  userId?: string;
  isWhole?: boolean;
  quote?: string;
  createTime?: number;
  updateTime?: number;
  replyList?: {
    replies?: FeishuDocumentCommentReply[];
  };
}

export interface FeishuTasklistMember {
  id: string;
  type?: string;
  role: 'assignee' | 'follower' | 'editor' | string;
  name?: string;
}

export interface FeishuChatInfo {
  chatId: string;
  name?: string;
  i18nNames?: {
    zh_cn?: string;
    en_us?: string;
    ja_jp?: string;
  };
}

export interface FeishuChatMember {
  memberId: string;
  memberIdType?: string;
  name?: string;
  tenantKey?: string;
}

export interface FeishuApplicationScopeGrant {
  scopeName: string;
  grantStatus: number;
}

export interface FeishuApplicationScopeApplyResult {
  submitted: true;
}

export interface FeishuApplicationInfo {
  appId: string;
  appName: string;
  status?: number;
}

export interface FeishuTaskCustomFieldValue {
  guid: string;
  single_select_value?: string;
  text_value?: string;
  number_value?: string;
  datetime_value?: string;
  member_value?: Array<{ id: string; type?: string; name?: string }>;
  multi_select_value?: string[];
}

export interface FeishuTaskOrigin {
  platform_i18n_name: {
    zh_cn?: string;
    en_us?: string;
  };
  href: {
    title: string;
    url: string;
  };
}

export interface FeishuTasklistResult {
  guid: string;
  url?: string;
  name?: string;
}

export interface FeishuTaskCustomField {
  guid: string;
  name: string;
  type: string;
  single_select_setting?: {
    options?: Array<{ guid?: string; option_guid?: string; name?: string }>;
  };
}

export interface FeishuTaskCustomFieldOption {
  guid: string;
  name: string;
}

export interface FeishuTaskSection {
  guid: string;
  name: string;
  is_default?: boolean;
}

export interface FeishuTaskResult {
  guid: string;
  url?: string;
  summary?: string;
}

export interface FeishuTasklistTaskSummary {
  guid: string;
  summary?: string;
  completedAt?: string;
}

interface FeishuMgetMessageItem {
  message_id?: string;
  msg_type?: string;
  message_type?: string;
  content?: string;
  body?: {
    content?: string;
  };
  sender?: {
    id?: string;
    name?: string;
  };
  thread_id?: string;
  root_id?: string;
  parent_id?: string;
  reference_message_id?: string;
  quote_message_id?: string;
  reference?: {
    message_id?: string;
  };
  upper_message_id?: string;
  message_app_link?: string;
}

interface FeishuApiResponse<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface PaginationResult<T> {
  items?: T[];
  has_more?: boolean;
  page_token?: string;
}

const DEFAULT_MAX_REQUEST_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const REPLY_FALLBACK_ERROR_CODES = new Set([230011, 231003]);
const MAX_DOCUMENT_COMMENT_REPLY_TEXT_LENGTH = 10_000;
const MAX_DOCUMENT_COMMENT_CREATE_TEXT_ELEMENT_LENGTH = 1_000;

function escapeDocumentCommentText(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function splitEscapedDocumentCommentText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const character of text) {
    const escaped = escapeDocumentCommentText(character);
    if (current && current.length + escaped.length > maxLength) {
      chunks.push(current);
      current = '';
    }
    current += escaped;
  }
  if (current) chunks.push(current);
  return chunks;
}

function appendDocumentCommentTextElements(
  target: FeishuDocumentCommentCreateApiElement[],
  text: string,
): void {
  for (const chunk of splitEscapedDocumentCommentText(
    text,
    MAX_DOCUMENT_COMMENT_CREATE_TEXT_ELEMENT_LENGTH,
  )) {
    target.push({ type: 'text', text: chunk });
  }
}

function serializeDocumentCommentCreateElements(
  elements: FeishuDocumentCommentCreateElement[],
): FeishuDocumentCommentCreateApiElement[] {
  const serialized: FeishuDocumentCommentCreateApiElement[] = [];
  for (const element of elements) {
    if (element.type === 'mention_user' && element.mentionUser) {
      serialized.push({ type: 'mention_user', mention_user: element.mentionUser });
      continue;
    }
    appendDocumentCommentTextElements(serialized, element.text ?? '');
  }
  return serialized;
}

class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly details: { status?: number; code?: number; body?: string } = {},
  ) {
    super(message);
    this.name = 'FeishuApiError';
  }
}

export class FeishuClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenRefreshPromise: Promise<string> | null = null;
  private readonly baseUrl: string;
  private readonly logger;

  constructor(private readonly config: FeishuClientConfig) {
    this.baseUrl = config.baseUrl ?? 'https://open.feishu.cn/open-apis';
    this.logger = createLogger('feishu-client');
  }

  private get maxRequestAttempts(): number {
    return Math.max(1, this.config.maxRequestAttempts ?? DEFAULT_MAX_REQUEST_ATTEMPTS);
  }

  private get retryDelayMs(): number {
    return Math.max(0, this.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  }

  private get requestTimeoutMs(): number {
    return Math.max(1, this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  private async sleepBeforeRetry(attempt: number): Promise<void> {
    if (this.retryDelayMs === 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * Math.pow(2, attempt)));
  }

  private shouldRetryResponse(res: Response): boolean {
    return res.status === 429 || res.status >= 500;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    operation: string,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRequestAttempts; attempt += 1) {
      try {
        // Per-attempt timeout; the signal stays active after fetch resolves,
        // so it also bounds the caller's response body read.
        const signal = init.signal ?? AbortSignal.timeout(this.requestTimeoutMs);
        const res = await fetch(url, { ...init, signal });
        if (attempt < this.maxRequestAttempts - 1 && this.shouldRetryResponse(res)) {
          await res.text().catch(() => '');
          await this.sleepBeforeRetry(attempt);
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (attempt >= this.maxRequestAttempts - 1) break;
        await this.sleepBeforeRetry(attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`${operation} failed after retries`);
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    // Single-flight: concurrent callers share one refresh instead of
    // stampeding the token endpoint.
    if (!this.tokenRefreshPromise) {
      this.tokenRefreshPromise = this.refreshToken().finally(() => {
        this.tokenRefreshPromise = null;
      });
    }
    return this.tokenRefreshPromise;
  }

  private async refreshToken(): Promise<string> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
      'ensureToken',
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new FeishuApiError(`ensureToken failed: HTTP ${res.status} ${body}`, 'ensureToken', {
        status: res.status,
        body,
      });
    }

    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if ((data.code !== undefined && data.code !== 0) || !data.tenant_access_token) {
      throw new FeishuApiError(
        `ensureToken failed: code ${data.code} ${data.msg ?? 'missing tenant_access_token'}`,
        'ensureToken',
        { code: data.code },
      );
    }

    const expireSec =
      typeof data.expire === 'number' && Number.isFinite(data.expire) ? data.expire : 120;
    this.accessToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Math.max(0, expireSec - 60) * 1000;
    return this.accessToken;
  }

  async sendMessage(
    receiveIdType: 'chat_id' | 'open_id',
    receiveId: string,
    content:
      | InteractiveCard
      | { msg_type: 'text'; content: { text: string } }
      | { msg_type: 'post'; content: PostContent },
    replyToMessageId?: string,
    options: SendMessageOptions = {},
  ): Promise<SendMessageResult> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/im/v1/messages?receive_id_type=${receiveIdType}`;

    let serializedContent: string;
    if (content.msg_type === 'interactive') {
      serializedContent = JSON.stringify(content.card);
    } else {
      serializedContent = JSON.stringify(content.content);
    }

    const messageUuid = options.uuid ?? randomUUID();
    const body: Record<string, unknown> = {
      receive_id: receiveId,
      msg_type: content.msg_type,
      content: serializedContent,
      uuid: messageUuid,
    };

    const sendCreateMessage = async (): Promise<SendMessageResult> => {
      const res = await this.fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        },
        'sendMessage',
      );

      const data = await this.parseApiResponse<{ message_id?: string }>(res, 'sendMessage');
      return { messageId: data.data?.message_id ?? '' };
    };

    if (replyToMessageId) {
      const replyUrl = `${this.baseUrl}/im/v1/messages/${replyToMessageId}/reply`;
      try {
        const res = await this.fetchWithRetry(
          replyUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              msg_type: content.msg_type,
              content: serializedContent,
              reply_in_thread: true,
              uuid: messageUuid,
            }),
          },
          'sendMessage',
        );
        const data = await this.parseApiResponse<{ message_id?: string }>(res, 'sendMessage');
        return { messageId: data.data?.message_id ?? '' };
      } catch (err) {
        const code = err instanceof FeishuApiError ? err.details.code : undefined;
        if (typeof code === 'number' && REPLY_FALLBACK_ERROR_CODES.has(code)) {
          this.logger.warn(
            { err, replyToMessageId, receiveIdType, receiveId },
            'Feishu reply target is unavailable, falling back to a new message',
          );
          return sendCreateMessage();
        }
        throw err;
      }
    }

    return sendCreateMessage();
  }

  async updateMessage(messageId: string, card: InteractiveCard): Promise<void> {
    const token = await this.ensureToken();
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/im/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          content: JSON.stringify(card.card),
        }),
      },
      'updateMessage',
    );

    try {
      await this.parseApiResponse(res, 'updateMessage');
    } catch (err) {
      this.logger.error({ err, messageId }, 'Failed to update message');
      throw err;
    }
  }

  async addReaction(messageId: string, emojiType: string): Promise<{ reactionId: string }> {
    const token = await this.ensureToken();
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/im/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          reaction_type: { emoji_type: emojiType },
        }),
      },
      'addReaction',
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`addReaction failed: HTTP ${res.status} ${body}`);
    }
    const data = (await res.json()) as { data?: { reaction_id?: string } };
    return { reactionId: data.data?.reaction_id ?? '' };
  }

  async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/im/v1/messages/${messageId}/resources/${imageKey}?type=image`;
    const res = await this.fetchWithRetry(
      url,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      'downloadImage',
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`downloadImage failed: HTTP ${res.status} ${body}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async downloadFile(
    messageId: string,
    fileKey: string,
    resourceType: 'file' | 'audio' | 'media' = 'file',
  ): Promise<Buffer> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/im/v1/messages/${messageId}/resources/${fileKey}?type=${resourceType}`;
    const res = await this.fetchWithRetry(
      url,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      'downloadFile',
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`downloadFile failed: HTTP ${res.status} ${body}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const token = await this.ensureToken();
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/im/v1/messages/${messageId}/reactions/${reactionId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      'removeReaction',
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`removeReaction failed: HTTP ${res.status} ${body}`);
    }
  }

  async createDocumentCommentReply(input: {
    fileToken: string;
    fileType: string;
    commentId: string;
    content: string;
  }): Promise<FeishuDocumentCommentReplyResult> {
    const content = escapeDocumentCommentText(input.content).slice(
      0,
      MAX_DOCUMENT_COMMENT_REPLY_TEXT_LENGTH,
    );
    const data = await this.requestApi<{
      reply_id?: string;
      reply?: {
        reply_id?: string;
      };
    }>(
      'POST',
      `/drive/v1/files/${encodeURIComponent(input.fileToken)}/comments/${encodeURIComponent(
        input.commentId,
      )}/replies`,
      {
        operation: 'createDocumentCommentReply',
        query: { file_type: input.fileType, user_id_type: 'open_id' },
        body: {
          content: {
            elements: [{ type: 'text_run', text_run: { text: content } }],
          },
        },
      },
    );
    return { replyId: data.data?.reply?.reply_id ?? data.data?.reply_id ?? '' };
  }

  async subscribeDocumentCommentEvents(): Promise<void> {
    await this.requestApi('POST', '/drive/v1/user/subscription', {
      operation: 'subscribeDocumentCommentEvents',
      body: { event_type: 'drive.notice.comment_add_v1' },
    });
  }

  async updateDocumentCommentReplyReaction(
    input: FeishuDocumentCommentReplyReactionInput,
  ): Promise<void> {
    await this.requestApi(
      'POST',
      `/drive/v2/files/${encodeURIComponent(input.fileToken)}/comments/reaction`,
      {
        operation: 'updateDocumentCommentReplyReaction',
        query: { file_type: input.fileType },
        body: {
          action: input.action ?? 'add',
          reply_id: input.replyId,
          reaction_type: input.reactionType,
        },
      },
    );
  }

  async createDocumentComment(input: {
    fileToken: string;
    fileType: string;
    content?: string;
    elements?: FeishuDocumentCommentCreateElement[];
  }): Promise<FeishuDocumentCommentCreateResult> {
    const replyElements = input.elements?.length
      ? serializeDocumentCommentCreateElements(input.elements)
      : serializeDocumentCommentCreateElements([{ type: 'text', text: input.content ?? 'Done.' }]);
    const data = await this.requestApi<{
      comment_id?: string;
      reply_id?: string;
    }>('POST', `/drive/v1/files/${encodeURIComponent(input.fileToken)}/new_comments`, {
      operation: 'createDocumentComment',
      body: {
        file_type: input.fileType,
        reply_elements: replyElements.length ? replyElements : [{ type: 'text', text: 'Done.' }],
      },
    });
    return {
      commentId: data.data?.comment_id ?? '',
      replyId: data.data?.reply_id,
    };
  }

  async getDocumentComment(input: {
    fileToken: string;
    fileType: string;
    commentId: string;
    isWhole?: boolean;
  }): Promise<FeishuDocumentComment | null> {
    const wholeCandidates = typeof input.isWhole === 'boolean' ? [input.isWhole] : [true, false];

    for (const isWhole of wholeCandidates) {
      let pageToken = '';
      do {
        const data = await this.requestApi<
          PaginationResult<{
            comment_id?: string;
            user_id?: string;
            is_whole?: boolean;
            quote?: string;
            create_time?: number;
            update_time?: number;
            reply_list?: {
              replies?: Array<{
                reply_id?: string;
                user_id?: string;
                create_time?: number;
                update_time?: number;
                content?: {
                  elements?: Array<{
                    type?: string;
                    text_run?: { text?: string } | null;
                    person?: { user_id?: string } | null;
                  }>;
                };
              }>;
            };
          }>
        >('GET', `/drive/v1/files/${encodeURIComponent(input.fileToken)}/comments`, {
          operation: 'getDocumentComment',
          query: {
            file_type: input.fileType,
            user_id_type: 'open_id',
            is_whole: String(isWhole),
            page_size: '100',
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });

        const found = data.data?.items?.find((comment) => comment.comment_id === input.commentId);
        if (found) {
          return {
            commentId: found.comment_id ?? input.commentId,
            userId: found.user_id,
            isWhole: found.is_whole,
            quote: found.quote,
            createTime: found.create_time,
            updateTime: found.update_time,
            replyList: {
              replies: (found.reply_list?.replies ?? [])
                .filter((reply) => reply.reply_id)
                .map((reply) => ({
                  replyId: reply.reply_id ?? '',
                  userId: reply.user_id,
                  createTime: reply.create_time,
                  updateTime: reply.update_time,
                  content: {
                    elements: (reply.content?.elements ?? []).map((element) => ({
                      type: element.type,
                      textRun: element.text_run ? { text: element.text_run.text } : null,
                      person: element.person ? { userId: element.person.user_id } : null,
                    })),
                  },
                })),
            },
          };
        }
        pageToken = data.data?.has_more ? (data.data.page_token ?? '') : '';
      } while (pageToken);
    }

    return null;
  }

  async createTasklist(input: {
    name: string;
    members?: FeishuTasklistMember[];
  }): Promise<FeishuTasklistResult> {
    const data = await this.requestApi<{ tasklist?: FeishuTasklistResult }>(
      'POST',
      '/task/v2/tasklists',
      {
        operation: 'createTasklist',
        body: { name: input.name, members: input.members },
      },
    );
    return data.data?.tasklist ?? { guid: '' };
  }

  async getChat(chatId: string): Promise<FeishuChatInfo> {
    const data = await this.requestApi<{
      name?: string;
      i18n_names?: {
        zh_cn?: string;
        en_us?: string;
        ja_jp?: string;
      };
    }>('GET', `/im/v1/chats/${encodeURIComponent(chatId)}`, {
      operation: 'getChat',
      query: { user_id_type: 'open_id' },
    });

    return {
      chatId,
      name: data.data?.name,
      i18nNames: data.data?.i18n_names,
    };
  }

  async listChatMembers(chatId: string): Promise<FeishuChatMember[]> {
    const items: FeishuChatMember[] = [];
    let pageToken = '';
    do {
      const data = await this.requestApi<
        PaginationResult<{
          member_id?: string;
          member_id_type?: string;
          name?: string;
          tenant_key?: string;
        }>
      >('GET', `/im/v1/chats/${encodeURIComponent(chatId)}/members`, {
        operation: 'listChatMembers',
        query: {
          member_id_type: 'open_id',
          page_size: '100',
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      for (const item of data.data?.items ?? []) {
        if (!item.member_id) continue;
        items.push({
          memberId: item.member_id,
          memberIdType: item.member_id_type,
          name: item.name,
          tenantKey: item.tenant_key,
        });
      }
      pageToken = data.data?.has_more ? (data.data.page_token ?? '') : '';
    } while (pageToken);
    return items;
  }

  async listApplicationScopes(): Promise<FeishuApplicationScopeGrant[]> {
    const data = await this.requestApi<{
      scopes?: Array<{
        scope_name?: string;
        grant_status?: number;
      }>;
    }>('GET', '/application/v6/scopes', {
      operation: 'listApplicationScopes',
    });

    return (data.data?.scopes ?? [])
      .filter(
        (scope): scope is { scope_name: string; grant_status: number } =>
          Boolean(scope.scope_name) && typeof scope.grant_status === 'number',
      )
      .map((scope) => ({
        scopeName: scope.scope_name,
        grantStatus: scope.grant_status,
      }));
  }

  async getApplicationInfo(
    input: {
      appId?: string;
      lang?: 'zh_cn' | 'en_us' | 'ja_jp';
    } = {},
  ): Promise<FeishuApplicationInfo> {
    const appId = input.appId?.trim() || this.config.appId;
    const data = await this.requestApi<{
      app?: {
        app_id?: string;
        app_name?: string;
        status?: number;
      };
    }>('GET', `/application/v6/applications/${encodeURIComponent(appId)}`, {
      operation: 'getApplicationInfo',
      query: {
        lang: input.lang ?? 'zh_cn',
        user_id_type: 'open_id',
      },
    });
    const app = data.data?.app;
    const appName = app?.app_name?.trim();
    if (!appName) {
      throw new Error('getApplicationInfo returned no application name');
    }
    return {
      appId: app?.app_id ?? appId,
      appName,
      status: app?.status,
    };
  }

  async applyApplicationScopes(): Promise<FeishuApplicationScopeApplyResult> {
    await this.requestApi('POST', '/application/v6/scopes/apply', {
      operation: 'applyApplicationScopes',
    });
    return { submitted: true };
  }

  async addTasklistMembers(tasklistGuid: string, members: FeishuTasklistMember[]): Promise<void> {
    if (members.length === 0) return;
    await this.requestApi(
      'POST',
      `/task/v2/tasklists/${encodeURIComponent(tasklistGuid)}/add_members`,
      {
        operation: 'addTasklistMembers',
        query: { user_id_type: 'open_id' },
        body: { members },
      },
    );
  }

  async listTaskCustomFields(tasklistGuid: string): Promise<FeishuTaskCustomField[]> {
    const items: FeishuTaskCustomField[] = [];
    let pageToken = '';
    do {
      const data = await this.requestApi<PaginationResult<FeishuTaskCustomField>>(
        'GET',
        '/task/v2/custom_fields',
        {
          operation: 'listTaskCustomFields',
          query: {
            resource_type: 'tasklist',
            resource_id: tasklistGuid,
            page_size: '100',
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        },
      );
      items.push(...(data.data?.items ?? []));
      pageToken = data.data?.has_more ? (data.data.page_token ?? '') : '';
    } while (pageToken);
    return items;
  }

  async createTaskCustomField(input: {
    tasklistGuid: string;
    name: string;
    type: 'single_select';
    options: Array<{ name: string; color_index?: number }>;
  }): Promise<FeishuTaskCustomField> {
    const data = await this.requestApi<{ custom_field?: FeishuTaskCustomField }>(
      'POST',
      '/task/v2/custom_fields',
      {
        operation: 'createTaskCustomField',
        body: {
          resource_type: 'tasklist',
          resource_id: input.tasklistGuid,
          name: input.name,
          type: input.type,
          single_select_setting: { options: input.options },
        },
      },
    );
    return data.data?.custom_field ?? { guid: '', name: input.name, type: input.type };
  }

  async createTaskCustomFieldOption(
    customFieldGuid: string,
    name: string,
  ): Promise<FeishuTaskCustomFieldOption> {
    const data = await this.requestApi<{ option?: FeishuTaskCustomFieldOption }>(
      'POST',
      `/task/v2/custom_fields/${encodeURIComponent(customFieldGuid)}/options`,
      {
        operation: 'createTaskCustomFieldOption',
        body: { name },
      },
    );
    return data.data?.option ?? { guid: '', name };
  }

  async listTaskSections(tasklistGuid: string): Promise<FeishuTaskSection[]> {
    const items: FeishuTaskSection[] = [];
    let pageToken = '';
    do {
      const data = await this.requestApi<PaginationResult<FeishuTaskSection>>(
        'GET',
        '/task/v2/sections',
        {
          operation: 'listTaskSections',
          query: {
            resource_type: 'tasklist',
            resource_id: tasklistGuid,
            page_size: '100',
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        },
      );
      items.push(...(data.data?.items ?? []));
      pageToken = data.data?.has_more ? (data.data.page_token ?? '') : '';
    } while (pageToken);
    return items;
  }

  async createTaskSection(tasklistGuid: string, name: string): Promise<FeishuTaskSection> {
    const data = await this.requestApi<{ section?: FeishuTaskSection }>(
      'POST',
      '/task/v2/sections',
      {
        operation: 'createTaskSection',
        body: {
          resource_type: 'tasklist',
          resource_id: tasklistGuid,
          name,
        },
      },
    );
    return data.data?.section ?? { guid: '', name };
  }

  async createTask(input: {
    summary: string;
    description?: string;
    tasklistGuid: string;
    sectionGuid?: string;
    customFields?: FeishuTaskCustomFieldValue[];
    origin?: FeishuTaskOrigin;
    members?: FeishuTasklistMember[];
    clientToken?: string;
    extra?: string;
  }): Promise<FeishuTaskResult> {
    const data = await this.requestApi<{ task?: FeishuTaskResult }>('POST', '/task/v2/tasks', {
      operation: 'createTask',
      body: {
        summary: input.summary,
        description: input.description,
        client_token: input.clientToken,
        extra: input.extra,
        tasklists: [
          {
            tasklist_guid: input.tasklistGuid,
            ...(input.sectionGuid ? { section_guid: input.sectionGuid } : {}),
          },
        ],
        custom_fields: input.customFields,
        origin: input.origin,
        members: input.members,
      },
    });
    return data.data?.task ?? { guid: '' };
  }

  async patchTaskCustomFields(
    taskGuid: string,
    customFields: FeishuTaskCustomFieldValue[],
  ): Promise<void> {
    await this.requestApi('PATCH', `/task/v2/tasks/${encodeURIComponent(taskGuid)}`, {
      operation: 'patchTaskCustomFields',
      body: {
        update_fields: ['custom_fields'],
        task: { custom_fields: customFields },
      },
      query: { user_id_type: 'open_id' },
    });
  }

  async addTaskToTasklist(input: {
    taskGuid: string;
    tasklistGuid: string;
    sectionGuid?: string;
  }): Promise<void> {
    await this.requestApi(
      'POST',
      `/task/v2/tasks/${encodeURIComponent(input.taskGuid)}/add_tasklist`,
      {
        operation: 'addTaskToTasklist',
        query: { user_id_type: 'open_id' },
        body: {
          tasklist_guid: input.tasklistGuid,
          ...(input.sectionGuid ? { section_guid: input.sectionGuid } : {}),
        },
      },
    );
  }

  async removeTaskFromTasklist(input: { taskGuid: string; tasklistGuid: string }): Promise<void> {
    await this.requestApi(
      'POST',
      `/task/v2/tasks/${encodeURIComponent(input.taskGuid)}/remove_tasklist`,
      {
        operation: 'removeTaskFromTasklist',
        query: { user_id_type: 'open_id' },
        body: {
          tasklist_guid: input.tasklistGuid,
        },
      },
    );
  }

  async listTasklistTasks(input: {
    tasklistGuid: string;
    completed?: boolean;
    pageSize?: number;
  }): Promise<FeishuTasklistTaskSummary[]> {
    const items: FeishuTasklistTaskSummary[] = [];
    let pageToken = '';
    do {
      const data = await this.requestApi<
        PaginationResult<{ guid?: string; summary?: string; completed_at?: string }>
      >('GET', `/task/v2/tasklists/${encodeURIComponent(input.tasklistGuid)}/tasks`, {
        operation: 'listTasklistTasks',
        query: {
          user_id_type: 'open_id',
          page_size: String(input.pageSize ?? 100),
          ...(input.completed === undefined ? {} : { completed: String(input.completed) }),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      for (const item of data.data?.items ?? []) {
        if (!item.guid) continue;
        items.push({
          guid: item.guid,
          summary: item.summary,
          completedAt: item.completed_at,
        });
      }
      pageToken = data.data?.has_more ? (data.data.page_token ?? '') : '';
    } while (pageToken);
    return items;
  }

  async completeTask(taskGuid: string, completedAtMs = Date.now()): Promise<void> {
    await this.requestApi('PATCH', `/task/v2/tasks/${encodeURIComponent(taskGuid)}`, {
      operation: 'completeTask',
      query: { user_id_type: 'open_id' },
      body: {
        update_fields: ['completed_at'],
        task: { completed_at: String(completedAtMs) },
      },
    });
  }

  async uncompleteTask(taskGuid: string): Promise<void> {
    await this.requestApi('PATCH', `/task/v2/tasks/${encodeURIComponent(taskGuid)}`, {
      operation: 'uncompleteTask',
      query: { user_id_type: 'open_id' },
      body: {
        update_fields: ['completed_at'],
        task: { completed_at: '0' },
      },
    });
  }

  async getMessageAppLink(messageId: string): Promise<string | null> {
    const data = await this.requestApi<{
      items?: FeishuMgetMessageItem[];
      messages?: FeishuMgetMessageItem[];
    }>('GET', '/im/v1/messages/mget', {
      operation: 'getMessageAppLink',
      query: {
        card_msg_content_type: 'raw_card_content',
        message_ids: messageId,
      },
    });
    const items = data.data?.items ?? data.data?.messages ?? [];
    return items.find((item) => item.message_id === messageId)?.message_app_link ?? null;
  }

  async getMessage(messageId: string): Promise<FeishuMessageDetail | null> {
    const data = await this.requestApi<{
      items?: FeishuMgetMessageItem[];
      messages?: FeishuMgetMessageItem[];
    }>('GET', `/im/v1/messages/${encodeURIComponent(messageId)}`, {
      operation: 'getMessage',
      query: {
        user_id_type: 'open_id',
        card_msg_content_type: 'user_card_content',
      },
    });
    const items = data.data?.items ?? data.data?.messages ?? [];
    const item =
      items.find((candidate) => candidate.message_id === messageId) ??
      items.find((candidate) => !candidate.upper_message_id) ??
      items[0];
    if (!item) return null;
    const children = items
      .filter((candidate) => candidate !== item)
      .map((candidate) => this.mapMessageDetail(candidate))
      .filter((candidate): candidate is FeishuMessageDetail => candidate !== null);
    const mappedItem = this.mapMessageDetail(item, messageId);
    if (!mappedItem) return null;

    return {
      ...mappedItem,
      ...(children.length > 0 ? { children } : {}),
    };
  }

  private mapMessageDetail(
    item: FeishuMgetMessageItem,
    fallbackMessageId?: string,
  ): FeishuMessageDetail | null {
    const mappedMessageId = item.message_id ?? fallbackMessageId;
    if (!mappedMessageId) return null;
    return {
      messageId: mappedMessageId,
      messageType: item.msg_type ?? item.message_type,
      content: item.body?.content ?? item.content,
      ...(item.sender?.name || item.sender?.id
        ? { senderName: item.sender.name ?? item.sender.id }
        : {}),
      ...(item.thread_id ? { threadId: item.thread_id } : {}),
      ...(item.root_id ? { rootMessageId: item.root_id } : {}),
      ...(item.parent_id ? { parentMessageId: item.parent_id } : {}),
      ...(item.reference_message_id || item.quote_message_id || item.reference?.message_id
        ? {
            referenceMessageId:
              item.reference_message_id ?? item.quote_message_id ?? item.reference?.message_id,
          }
        : {}),
    };
  }

  private async parseApiResponse<T>(
    res: Response,
    operation: string,
  ): Promise<FeishuApiResponse<T>> {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new FeishuApiError(`${operation} failed: HTTP ${res.status} ${body}`, operation, {
        status: res.status,
        body,
      });
    }

    const data = (await res.json()) as FeishuApiResponse<T>;
    if (typeof data.code === 'number' && data.code !== 0) {
      const message = data.msg ? ` ${data.msg}` : '';
      throw new FeishuApiError(`${operation} failed: code ${data.code}${message}`, operation, {
        code: data.code,
      });
    }

    return data;
  }

  private async requestApi<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: {
      operation: string;
      query?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<FeishuApiResponse<T>> {
    const token = await this.ensureToken();
    const query = new URLSearchParams(options.query);
    const url = `${this.baseUrl}${path}${query.size > 0 ? `?${query.toString()}` : ''}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await this.fetchWithRetry(
      url,
      {
        method,
        headers,
        ...(method === 'GET' || options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      },
      options.operation,
    );
    return this.parseApiResponse<T>(res, options.operation);
  }
}
