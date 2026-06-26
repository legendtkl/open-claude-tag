import { describe, expect, it } from 'vitest';
import { ChatEventSerializer, getFeishuChatEventSerialKey } from '../chat-event-serializer.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ChatEventSerializer', () => {
  it('runs tasks for the same key in insertion order', async () => {
    const serializer = new ChatEventSerializer();
    const firstGate = deferred();
    const calls: string[] = [];

    const first = serializer.run('chat-1', async () => {
      calls.push('first:start');
      await firstGate.promise;
      calls.push('first:end');
      return 1;
    });
    const second = serializer.run('chat-1', async () => {
      calls.push('second:start');
      return 2;
    });

    await flushMicrotasks();
    expect(calls).toEqual(['first:start']);
    expect(serializer.getQueueDepth('chat-1')).toBe(2);

    firstGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(calls).toEqual(['first:start', 'first:end', 'second:start']);
    expect(serializer.activeKeyCount).toBe(0);
  });

  it('allows different keys to run concurrently', async () => {
    const serializer = new ChatEventSerializer();
    const firstGate = deferred();
    const secondGate = deferred();
    const calls: string[] = [];

    const first = serializer.run('chat-1', async () => {
      calls.push('first:start');
      await firstGate.promise;
    });
    const second = serializer.run('chat-2', async () => {
      calls.push('second:start');
      await secondGate.promise;
    });

    await flushMicrotasks();
    expect(calls.sort()).toEqual(['first:start', 'second:start']);
    expect(serializer.activeKeyCount).toBe(2);

    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([first, second]);
    expect(serializer.activeKeyCount).toBe(0);
  });

  it('continues a key after the previous task rejects', async () => {
    const serializer = new ChatEventSerializer();

    await expect(
      serializer.run('chat-1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(serializer.run('chat-1', async () => 'ok')).resolves.toBe('ok');
    expect(serializer.activeKeyCount).toBe(0);
  });
});

describe('getFeishuChatEventSerialKey', () => {
  it('extracts a key from normalized Feishu webhook events', () => {
    expect(
      getFeishuChatEventSerialKey({
        header: {
          tenant_key: 'tenant-1',
          app_id: 'cli_a',
        },
        event: {
          message: {
            chat_id: 'oc_1',
          },
        },
      }),
    ).toBe('feishu:tenant-1:cli_a:chat:oc_1');
  });

  it('extracts a key from flat Feishu SDK events', () => {
    expect(
      getFeishuChatEventSerialKey(
        {
          tenant_key: 'tenant-2',
          app_id: 'cli_b',
          message: {
            chat_id: 'oc_2',
          },
        },
        'fallback_app',
      ),
    ).toBe('feishu:tenant-2:cli_b:chat:oc_2');
  });

  it('returns undefined when the event has no chat id', () => {
    expect(getFeishuChatEventSerialKey({ header: {}, event: {} })).toBeUndefined();
  });

  it('extracts a stable key from Feishu document comment events', () => {
    expect(
      getFeishuChatEventSerialKey({
        header: {
          tenant_key: 'tenant-1',
          app_id: 'cli_a',
          event_type: 'drive.notice.comment_add_v1',
        },
        event: {
          file_token: 'doccnabc123',
          comment_id: 'comment_001',
        },
      }),
    ).toBe('feishu:tenant-1:cli_a:document-comment:doccnabc123:comment_001');
  });

  it('extracts a stable key from compact document comment notice metadata', () => {
    expect(
      getFeishuChatEventSerialKey({
        header: {
          tenant_key: 'tenant-1',
          app_id: 'cli_a',
          event_type: 'drive.notice.comment_add_v1',
        },
        event: {
          comment_id: 'comment_001',
          notice_meta: {
            file_token: 'doccnabc123',
            obj_type: 'docx',
          },
        },
      }),
    ).toBe('feishu:tenant-1:cli_a:document-comment:doccnabc123:comment_001');
  });
});
