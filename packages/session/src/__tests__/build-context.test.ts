import { describe, it, expect } from 'vitest';
import type { Database } from '@open-tag/storage';
import { sessions, memoryEntries, messages } from '@open-tag/storage';
import { buildContext } from '../context-builder.js';

// Minimal chainable Drizzle stub: every query in buildContext ends in `.limit()`,
// which resolves to the rows configured for the table passed to `.from()`.
function makeStubDb(rowsByTable: Map<unknown, unknown[]>): Database {
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    let table: unknown;
    b.from = (t: unknown) => {
      table = t;
      return b;
    };
    b.where = () => b;
    b.orderBy = () => b;
    b.limit = () => Promise.resolve(rowsByTable.get(table) ?? []);
    return b;
  };
  return { select: () => makeBuilder() } as unknown as Database;
}

const emptyRows = new Map<unknown, unknown[]>([
  [sessions, [{ summary: '' }]],
  [memoryEntries, []],
  [messages, []],
]);

describe('buildContext shared-context injection', () => {
  it('injects a verified shared-context section when entries are provided', async () => {
    const ctx = await buildContext(makeStubDb(emptyRows), 'sess-1', 'SYS', {
      includeSessionHistory: true,
      sharedContextEntries: [
        { memoryType: 'fact', gist: 'lambdify lacks trailing comma', authorAgentKind: 'claude_code' },
      ],
    });
    expect(ctx.memorySection).toContain('## Shared Context (verified)');
    expect(ctx.memorySection).toContain('lambdify lacks trailing comma');
  });

  it('produces no shared-context section when none is provided (parity)', async () => {
    const ctx = await buildContext(makeStubDb(emptyRows), 'sess-1', 'SYS', {
      includeSessionHistory: true,
    });
    expect(ctx.memorySection).not.toContain('Shared Context');
  });

  it('extracts referenced image attachments from included history messages', async () => {
    const ctx = await buildContext(
      makeStubDb(
        new Map<unknown, unknown[]>([
          [sessions, [{ summary: '' }]],
          [memoryEntries, []],
          [
            messages,
            [
              {
                role: 'user',
                content: '解读一下这个图片',
                feishuMessageId: 'om_request_1',
                tokenEstimate: 4,
                metadata: {
                  referencedMessages: [
                    {
                      messageId: 'om_image_1',
                      contentType: 'image',
                      entries: [],
                      imageAttachment: { imageKey: 'img_1', messageId: 'om_image_1' },
                    },
                  ],
                },
              },
            ],
          ],
        ]),
      ),
      'sess-1',
      'SYS',
      { includeSessionHistory: true },
    );

    expect(ctx.recentTurns).toEqual([
      { role: 'user', content: '解读一下这个图片', messageId: 'om_request_1' },
    ]);
    expect(ctx.recentImageAttachments).toEqual([
      {
        imageKey: 'img_1',
        messageId: 'om_image_1',
        sourceMessageId: 'om_image_1',
        sourceRole: 'user',
        sourceContent: '解读一下这个图片',
      },
    ]);
  });

  it('extracts direct image attachments from included history messages', async () => {
    const ctx = await buildContext(
      makeStubDb(
        new Map<unknown, unknown[]>([
          [sessions, [{ summary: '' }]],
          [memoryEntries, []],
          [
            messages,
            [
              {
                role: 'user',
                content: '这张图里有什么',
                feishuMessageId: 'om_direct_image_request',
                tokenEstimate: 4,
                metadata: {
                  imageAttachment: {
                    imageKey: 'img_direct_1',
                    messageId: 'om_direct_image_request',
                  },
                },
              },
            ],
          ],
        ]),
      ),
      'sess-1',
      'SYS',
      { includeSessionHistory: true },
    );

    expect(ctx.recentImageAttachments).toEqual([
      {
        imageKey: 'img_direct_1',
        messageId: 'om_direct_image_request',
        sourceMessageId: 'om_direct_image_request',
        sourceRole: 'user',
        sourceContent: '这张图里有什么',
      },
    ]);
  });
});
