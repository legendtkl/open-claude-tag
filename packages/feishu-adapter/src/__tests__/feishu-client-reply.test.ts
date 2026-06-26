import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuClient } from '../feishu-client.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeTokenResponse() {
  return {
    ok: true,
    json: async () => ({ tenant_access_token: 'test_token', expire: 7200 }),
  };
}

function makeReplyResponse(messageId = 'om_reply_001') {
  return {
    ok: true,
    json: async () => ({ data: { message_id: messageId } }),
  };
}

function makeApiErrorResponse(code: number, msg: string) {
  return {
    ok: true,
    json: async () => ({ code, msg }),
  };
}

function makeHttpErrorResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    text: async () => text,
  };
}

describe('FeishuClient sendMessage reply path', () => {
  let client: FeishuClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FeishuClient({ appId: 'app_id', appSecret: 'secret', retryDelayMs: 0 });
  });

  it('uses reply endpoint when replyToMessageId is provided', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeReplyResponse());

    await client.sendMessage(
      'chat_id',
      'oc_chat_001',
      { msg_type: 'text', content: { text: 'hello' } },
      'om_parent_001',
    );

    const replyCall = fetchMock.mock.calls[1];
    expect(replyCall[0]).toBe(
      'https://open.feishu.cn/open-apis/im/v1/messages/om_parent_001/reply',
    );
  });

  it('includes reply_in_thread: true in the reply request body', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeReplyResponse());

    await client.sendMessage(
      'chat_id',
      'oc_chat_001',
      { msg_type: 'text', content: { text: 'hello' } },
      'om_parent_001',
    );

    const replyCall = fetchMock.mock.calls[1];
    const body = JSON.parse(replyCall[1].body);
    expect(body.reply_in_thread).toBe(true);
  });

  it('includes uuid in reply requests when provided', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeReplyResponse());

    await client.sendMessage(
      'chat_id',
      'oc_chat_001',
      { msg_type: 'text', content: { text: 'hello' } },
      'om_parent_001',
      { uuid: 'render_uuid_001' },
    );

    const replyCall = fetchMock.mock.calls[1];
    const body = JSON.parse(replyCall[1].body);
    expect(body.uuid).toBe('render_uuid_001');
  });

  it('returns the message id from reply response', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeReplyResponse('om_reply_002'));

    const result = await client.sendMessage(
      'chat_id',
      'oc_chat_001',
      { msg_type: 'text', content: { text: 'hello' } },
      'om_parent_001',
    );

    expect(result.messageId).toBe('om_reply_002');
  });

  it('does not use reply endpoint when replyToMessageId is omitted', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeReplyResponse());

    await client.sendMessage('chat_id', 'oc_chat_001', {
      msg_type: 'text',
      content: { text: 'hello' },
    });

    const sendCall = fetchMock.mock.calls[1];
    expect(sendCall[0]).toBe(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
    );
  });

  it('includes uuid in create-message requests when provided', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeReplyResponse());

    await client.sendMessage(
      'chat_id',
      'oc_chat_001',
      { msg_type: 'text', content: { text: 'hello' } },
      undefined,
      { uuid: 'render_uuid_002' },
    );

    const sendCall = fetchMock.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    expect(body.uuid).toBe('render_uuid_002');
  });

  it('generates uuid in create-message requests when omitted', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeReplyResponse());

    await client.sendMessage('chat_id', 'oc_chat_001', {
      msg_type: 'text',
      content: { text: 'hello' },
    });

    const sendCall = fetchMock.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    expect(body.uuid).toEqual(expect.any(String));
    expect(body.uuid).not.toHaveLength(0);
  });

  it('falls back to a new chat message when the reply target is missing', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeApiErrorResponse(230011, 'message not found'))
      .mockResolvedValueOnce(makeReplyResponse('om_fallback_001'));

    const result = await client.sendMessage(
      'chat_id',
      'oc_chat_001',
      { msg_type: 'text', content: { text: 'hello' } },
      'om_missing_parent',
      { uuid: 'render_uuid_003' },
    );

    expect(result.messageId).toBe('om_fallback_001');
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://open.feishu.cn/open-apis/im/v1/messages/om_missing_parent/reply',
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
    );
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      receive_id: 'oc_chat_001',
      uuid: 'render_uuid_003',
    });
  });

  it('retries transient HTTP failures before returning a sent message', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeHttpErrorResponse(500, 'gateway timeout'))
      .mockResolvedValueOnce(makeReplyResponse('om_retry_001'));

    const result = await client.sendMessage('chat_id', 'oc_chat_001', {
      msg_type: 'text',
      content: { text: 'hello' },
    });

    expect(result.messageId).toBe('om_retry_001');
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[2][0]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).uuid).toBe(
      JSON.parse(fetchMock.mock.calls[2][1].body).uuid,
    );
  });
});
