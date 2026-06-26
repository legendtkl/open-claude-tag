import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@open-tag/storage';
import {
  chatConfigs,
  chatMemoryEntries,
  memoryEntries,
  messages,
  sessions,
  sharedContextEntries,
} from '@open-tag/storage';
import { buildContextualExecutionContext, buildContextualGoal } from '../context-builders.js';

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

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as never;

describe('buildContextualGoal shared context hydration', () => {
  it('injects chat memory before session memory and conversation history', async () => {
    const db = makeStubDb(
      new Map<unknown, unknown[]>([
        [chatConfigs, [{ memoryEnabled: true }]],
        [
          chatMemoryEntries,
          [
            {
              id: 'chat-index',
              entryType: 'index',
              title: 'index',
              content: 'This group prefers isolated verification.',
              keywords: [],
              importanceScore: 1,
              updatedAt: new Date('2026-06-24T00:00:00Z'),
            },
            {
              id: 'chat-detail',
              entryType: 'detail',
              title: 'E2E verification',
              content: 'Use pnpm test:e2e:isolated for worker changes.',
              keywords: ['e2e', 'verification'],
              importanceScore: 0.9,
              updatedAt: new Date('2026-06-24T00:00:00Z'),
            },
          ],
        ],
        [sessions, [{ summary: 'Session-specific summary.' }]],
        [memoryEntries, []],
        [sharedContextEntries, []],
        [messages, []],
      ]),
    );

    const prompt = await buildContextualGoal(
      db,
      logger,
      'session-1',
      'please run e2e verification',
      'task-1',
      '',
      {
        includeSessionHistory: true,
        chatMemory: { tenantKey: 'default', chatId: 'oc_chat' },
      },
    );

    expect(prompt).toContain('<chat_memory>');
    expect(prompt).toContain('This group prefers isolated verification.');
    expect(prompt).toContain('Use pnpm test:e2e:isolated');
    expect(prompt.indexOf('<chat_memory>')).toBeLessThan(prompt.indexOf('<session_memory>'));
  });

  it('omits chat memory when disabled without changing session context', async () => {
    const db = makeStubDb(
      new Map<unknown, unknown[]>([
        [chatConfigs, [{ memoryEnabled: false }]],
        [sessions, [{ summary: 'Session summary only.' }]],
        [memoryEntries, []],
        [sharedContextEntries, []],
        [messages, []],
      ]),
    );

    const prompt = await buildContextualGoal(
      db,
      logger,
      'session-1',
      'continue',
      'task-1',
      '',
      {
        includeSessionHistory: true,
        chatMemory: { tenantKey: 'default', chatId: 'oc_chat' },
      },
    );

    expect(prompt).not.toContain('<chat_memory>');
    expect(prompt).toContain('<session_memory>');
    expect(prompt).toContain('Session summary only.');
  });

  it('injects same-session messages from other agents for cross-agent review', async () => {
    const db = makeStubDb(
      new Map<unknown, unknown[]>([
        [sessions, [{ summary: '' }]],
        [memoryEntries, []],
        [
          sharedContextEntries,
          [
            {
              id: 'sc-1',
              sessionId: 'session-1',
              scopeType: 'session',
              scopeId: 'session-1',
              authorAgentId: 'agent-a',
              authorAgentKind: 'claude_code',
              authorMachineId: 'machine-a',
              memoryType: 'summary',
              gist: 'Agent A concluded the diagram is about Agent engineering governance.',
              evidenceRef: { kind: 'inline', inline: 'evidence' },
              verified: true,
              importanceScore: 0.9,
              createdAt: new Date('2026-06-15T00:00:00Z'),
            },
          ],
        ],
        [
          messages,
          [
            {
              role: 'user',
              content: 'initial question',
              agentId: null,
              tokenEstimate: 3,
            },
            {
              role: 'assistant',
              content: 'Agent A visible answer from this Feishu topic.',
              agentId: 'agent-a',
              tokenEstimate: 8,
            },
            {
              role: 'assistant',
              content: 'Agent B own prior answer',
              agentId: 'agent-b',
              tokenEstimate: 5,
            },
          ],
        ],
      ]),
    );

    const prompt = await buildContextualGoal(
      db,
      logger,
      'session-1',
      'can you compare with agent A?',
      'task-1',
      '',
      { agentId: 'agent-b', includeSessionHistory: true },
    );

    expect(prompt).toContain('<session_memory>');
    expect(prompt).toContain(
      'Agent A concluded the diagram is about Agent engineering governance.',
    );
    expect(prompt).toContain('<conversation_history>');
    expect(prompt).toContain('Agent A visible answer from this Feishu topic.');
    expect(prompt).toContain('Agent B own prior answer');
    expect(prompt).toContain(
      '<current_request>\ncan you compare with agent A?\n</current_request>',
    );
  });

  it('returns historical referenced images for fresh cross-agent execution', async () => {
    const db = makeStubDb(
      new Map<unknown, unknown[]>([
        [sessions, [{ summary: '' }]],
        [memoryEntries, []],
        [sharedContextEntries, []],
        [
          messages,
          [
            {
              role: 'user',
              content: '解读一下这个图片',
              agentId: 'agent-a',
              tokenEstimate: 5,
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
            {
              role: 'assistant',
              content: 'Agent A said the image contains a workflow diagram.',
              agentId: 'agent-a',
              tokenEstimate: 8,
            },
          ],
        ],
      ]),
    );

    const context = await buildContextualExecutionContext(
      db,
      logger,
      'session-1',
      'please review agent A',
      'task-2',
      '',
      { agentId: 'agent-b', includeSessionHistory: true },
    );

    expect(context.goal).toContain('<conversation_images>');
    expect(context.goal).toContain('messageId="om_image_1"');
    expect(context.goal).toContain('Agent A said the image contains a workflow diagram.');
    expect(context.imageAttachments).toEqual([{ imageKey: 'img_1', messageId: 'om_image_1' }]);
  });

  it('keeps same-text historical images and filters only the current request image', async () => {
    const db = makeStubDb(
      new Map<unknown, unknown[]>([
        [sessions, [{ summary: '' }]],
        [memoryEntries, []],
        [sharedContextEntries, []],
        [
          messages,
          [
            {
              role: 'user',
              content: '解读一下这个图片',
              feishuMessageId: 'om_previous_request',
              agentId: 'agent-a',
              tokenEstimate: 5,
              metadata: {
                referencedMessages: [
                  {
                    messageId: 'om_previous_image',
                    contentType: 'image',
                    entries: [],
                    imageAttachment: { imageKey: 'img_previous', messageId: 'om_previous_image' },
                  },
                ],
              },
            },
            {
              role: 'user',
              content: '解读一下这个图片',
              feishuMessageId: 'om_current_request',
              agentId: 'agent-b',
              tokenEstimate: 5,
              metadata: {
                imageAttachment: { imageKey: 'img_current', messageId: 'om_current_request' },
              },
            },
          ],
        ],
      ]),
    );

    const context = await buildContextualExecutionContext(
      db,
      logger,
      'session-1',
      '解读一下这个图片',
      'task-3',
      '',
      {
        agentId: 'agent-b',
        includeSessionHistory: true,
        currentMessageId: 'om_current_request',
        currentImageAttachment: { imageKey: 'img_current', messageId: 'om_current_request' },
      },
    );

    expect(context.goal).toContain('messageId="om_previous_image"');
    expect(context.goal).not.toContain('messageId="om_current_request"');
    expect(context.imageAttachments).toEqual([
      { imageKey: 'img_previous', messageId: 'om_previous_image' },
    ]);
  });

  it('marks conversation image context as truncated when the history image budget is exceeded', async () => {
    const history = Array.from({ length: 10 }, (_, rawIndex) => {
      const index = 10 - rawIndex;
      return {
        role: 'user',
        content: `历史图片 ${index}`,
        feishuMessageId: `om_history_${index}`,
        agentId: 'agent-a',
        tokenEstimate: 3,
        metadata: {
          imageAttachment: {
            imageKey: `img_history_${index}`,
            messageId: `om_history_${index}`,
          },
        },
      };
    });
    const db = makeStubDb(
      new Map<unknown, unknown[]>([
        [sessions, [{ summary: '' }]],
        [memoryEntries, []],
        [sharedContextEntries, []],
        [messages, history],
      ]),
    );

    const context = await buildContextualExecutionContext(
      db,
      logger,
      'session-1',
      '看一下历史图',
      'task-4',
      '',
      { agentId: 'agent-b', includeSessionHistory: true, currentMessageId: 'om_current' },
    );

    expect(context.imageAttachments).toHaveLength(8);
    expect(context.goal).toContain('<conversation_images truncated="true" omitted="2">');
    expect(context.goal).not.toContain('imageKey="img_history_1"');
    expect(context.goal).toContain('imageKey="img_history_10"');
  });
});
