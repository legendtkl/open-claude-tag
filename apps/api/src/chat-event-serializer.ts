type SerialTask<T> = () => Promise<T>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

export class ChatEventSerializer {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();

  get activeKeyCount(): number {
    return this.tails.size;
  }

  getQueueDepth(key: string): number {
    return this.depths.get(key) ?? 0;
  }

  async run<T>(key: string | undefined, task: SerialTask<T>): Promise<T> {
    if (!key) {
      return task();
    }

    const previousTail = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextTail = previousTail.catch(() => undefined).then(() => currentTail);
    this.tails.set(key, nextTail);
    this.depths.set(key, (this.depths.get(key) ?? 0) + 1);

    await previousTail.catch(() => undefined);

    try {
      return await task();
    } finally {
      release();
      const remainingDepth = (this.depths.get(key) ?? 1) - 1;
      if (remainingDepth > 0) {
        this.depths.set(key, remainingDepth);
      } else {
        this.depths.delete(key);
      }
      if (this.tails.get(key) === nextTail) {
        this.tails.delete(key);
      }
    }
  }
}

export function getFeishuChatEventSerialKey(
  raw: unknown,
  fallbackAppId?: string,
): string | undefined {
  const envelope = getRecord(raw);
  if (!envelope) {
    return undefined;
  }

  const header = getRecord(envelope.header);
  const event = getRecord(envelope.event);
  const message = getRecord(event?.message) ?? getRecord(envelope.message);
  const chatId = nonEmptyString(message?.chat_id) ?? nonEmptyString(message?.chatId);
  const tenantKey =
    nonEmptyString(header?.tenant_key) ??
    nonEmptyString(envelope.tenant_key) ??
    nonEmptyString(event?.tenant_key) ??
    'default';
  const appId =
    nonEmptyString(header?.app_id) ??
    nonEmptyString(envelope.app_id) ??
    nonEmptyString(event?.app_id) ??
    fallbackAppId ??
    'unknown-app';

  if (chatId) {
    return `feishu:${tenantKey}:${appId}:chat:${chatId}`;
  }

  const eventType =
    nonEmptyString(header?.event_type) ??
    nonEmptyString(envelope.event_type) ??
    nonEmptyString(event?.event_type);
  if (eventType === 'drive.notice.comment_add_v1') {
    const noticeMeta = getRecord(event?.notice_meta) ?? getRecord(event?.noticeMeta);
    const fileToken =
      nonEmptyString(event?.file_token) ??
      nonEmptyString(event?.fileToken) ??
      nonEmptyString(noticeMeta?.file_token) ??
      nonEmptyString(noticeMeta?.fileToken) ??
      nonEmptyString(noticeMeta?.obj_token) ??
      nonEmptyString(noticeMeta?.objToken) ??
      nonEmptyString(noticeMeta?.token) ??
      nonEmptyString(envelope.file_token) ??
      nonEmptyString(envelope.fileToken);
    const commentId =
      nonEmptyString(event?.comment_id) ??
      nonEmptyString(event?.commentId) ??
      nonEmptyString(noticeMeta?.comment_id) ??
      nonEmptyString(noticeMeta?.commentId) ??
      nonEmptyString(envelope.comment_id) ??
      nonEmptyString(envelope.commentId);
    if (fileToken && commentId) {
      return `feishu:${tenantKey}:${appId}:document-comment:${fileToken}:${commentId}`;
    }
  }

  if (!chatId) {
    return undefined;
  }
}
