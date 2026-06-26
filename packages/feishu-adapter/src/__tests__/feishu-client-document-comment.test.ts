import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuClient } from '../feishu-client.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeTokenResponse() {
  return {
    ok: true,
    json: async () => ({ tenant_access_token: 'test_token', expire: 7200 }),
  };
}

function makeApiResponse(data: unknown) {
  return {
    ok: true,
    json: async () => ({ code: 0, data }),
  };
}

describe('FeishuClient document comment APIs', () => {
  let client: FeishuClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FeishuClient({ appId: 'app_id', appSecret: 'secret' });
  });

  it('creates a document comment reply with escaped text elements', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeApiResponse({ reply: { reply_id: 'reply_001' } }));

    const result = await client.createDocumentCommentReply({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      commentId: 'comment_001',
      content: 'Trace <analysis> done',
    });

    expect(result).toEqual({ replyId: 'reply_001' });
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://open.feishu.cn/open-apis/drive/v1/files/doccnabc123/comments/comment_001/replies?file_type=docx&user_id_type=open_id',
    );
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      content: {
        elements: [{ type: 'text_run', text_run: { text: 'Trace &lt;analysis&gt; done' } }],
      },
    });
  });

  it('subscribes the app to document comment add events', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(makeApiResponse({}));

    await client.subscribeDocumentCommentEvents();

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://open.feishu.cn/open-apis/drive/v1/user/subscription');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      event_type: 'drive.notice.comment_add_v1',
    });
  });

  it('adds a reaction to a document comment reply', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(makeApiResponse({}));

    await client.updateDocumentCommentReplyReaction({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      replyId: 'reply_001',
      reactionType: 'OK',
    });

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://open.feishu.cn/open-apis/drive/v2/files/doccnabc123/comments/reaction?file_type=docx',
    );
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      action: 'add',
      reply_id: 'reply_001',
      reaction_type: 'OK',
    });
  });

  it('creates a full document comment with text elements', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeApiResponse({ comment_id: 'comment_002', reply_id: 'reply_002' }));

    const result = await client.createDocumentComment({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      content: 'Fallback <done>',
    });

    expect(result).toEqual({ commentId: 'comment_002', replyId: 'reply_002' });
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://open.feishu.cn/open-apis/drive/v1/files/doccnabc123/new_comments');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      file_type: 'docx',
      reply_elements: [{ type: 'text', text: 'Fallback &lt;done&gt;' }],
    });
  });

  it('splits full document comment text elements to Feishu create limits', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeApiResponse({ comment_id: 'comment_002', reply_id: 'reply_002' }));

    await client.createDocumentComment({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      content: 'a'.repeat(1001),
    });

    const [, opts] = fetchMock.mock.calls[1];
    expect(JSON.parse(opts.body)).toEqual({
      file_type: 'docx',
      reply_elements: [
        { type: 'text', text: 'a'.repeat(1000) },
        { type: 'text', text: 'a' },
      ],
    });
  });

  it('creates a full document comment with mention and text elements', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeApiResponse({ comment_id: 'comment_003', reply_id: 'reply_003' }));

    const result = await client.createDocumentComment({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      elements: [
        { type: 'mention_user', mentionUser: 'ou_requester' },
        { type: 'text', text: ' Trace <analysis> done' },
      ],
    });

    expect(result).toEqual({ commentId: 'comment_003', replyId: 'reply_003' });
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://open.feishu.cn/open-apis/drive/v1/files/doccnabc123/new_comments');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      file_type: 'docx',
      reply_elements: [
        { type: 'mention_user', mention_user: 'ou_requester' },
        { type: 'text', text: ' Trace &lt;analysis&gt; done' },
      ],
    });
  });

  it('splits long full document comment text while preserving mention elements', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeApiResponse({ comment_id: 'comment_003', reply_id: 'reply_003' }));

    await client.createDocumentComment({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      elements: [
        { type: 'mention_user', mentionUser: 'ou_requester' },
        { type: 'text', text: `${'b'.repeat(999)}<>` },
      ],
    });

    const [, opts] = fetchMock.mock.calls[1];
    expect(JSON.parse(opts.body)).toEqual({
      file_type: 'docx',
      reply_elements: [
        { type: 'mention_user', mention_user: 'ou_requester' },
        { type: 'text', text: 'b'.repeat(999) },
        { type: 'text', text: '&lt;&gt;' },
      ],
    });
  });

  it('gets a document comment by id and maps reply elements', async () => {
    fetchMock.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce(
      makeApiResponse({
        has_more: false,
        items: [
          {
            comment_id: 'comment_001',
            user_id: 'ou_user_001',
            is_whole: true,
            quote: 'Meta Harness',
            create_time: 1710000000,
            update_time: 1710000001,
            reply_list: {
              replies: [
                {
                  reply_id: 'reply_001',
                  user_id: 'ou_user_001',
                  content: {
                    elements: [
                      {
                        type: 'person',
                        person: { user_id: 'ou_bot_001' },
                      },
                      {
                        type: 'text_run',
                        text_run: { text: ' please investigate Trace AI analysis' },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const result = await client.getDocumentComment({
      fileToken: 'doccnabc123',
      fileType: 'docx',
      commentId: 'comment_001',
    });

    expect(result).toMatchObject({
      commentId: 'comment_001',
      userId: 'ou_user_001',
      isWhole: true,
      quote: 'Meta Harness',
      replyList: {
        replies: [
          {
            replyId: 'reply_001',
            userId: 'ou_user_001',
            content: {
              elements: [
                { type: 'person', person: { userId: 'ou_bot_001' } },
                {
                  type: 'text_run',
                  textRun: { text: ' please investigate Trace AI analysis' },
                },
              ],
            },
          },
        ],
      },
    });
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://open.feishu.cn/open-apis/drive/v1/files/doccnabc123/comments?file_type=docx&user_id_type=open_id&is_whole=true&page_size=100',
    );
    expect(opts.method).toBe('GET');
  });
});
