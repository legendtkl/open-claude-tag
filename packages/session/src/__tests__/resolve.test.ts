import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  aliasThreadKeysForSession,
  canonicalizeSessionId,
  resolveSession as resolveSessionInbound,
  upgradeProvisionalSession,
} from '../resolve.js';
import { adaptNormalizedEvent } from '@open-tag/feishu-adapter';
import type { NormalizedEvent } from '@open-tag/core-types';

// resolveSession now takes the neutral InboundMessage. The existing cases build
// NormalizedEvents, so route them through the REAL adapter — this also proves the
// migrated resolver keys lark sessions byte-identically off the neutral contract.
function resolveSession(db: Parameters<typeof resolveSessionInbound>[0], event: NormalizedEvent) {
  return resolveSessionInbound(db, adaptNormalizedEvent(event));
}
import {
  admissionLeases,
  agentDelegations,
  agentSessionStates,
  discussions,
  discussionParticipants,
  discussionTurns,
  memoryEntries,
  messages,
  sharedContextEntries,
  tasks,
  waitingContracts,
} from '@open-tag/storage';

type SessionRow = {
  id: string;
  sessionKey: string;
  chatId: string;
  scope: string;
  status: string;
  adhocWorkDir?: string | null;
  runtimeBackend?: string | null;
  worktreePath?: string | null;
  projectId?: string | null;
};

type SessionAliasRow = {
  id: string;
  aliasKey: string;
  targetSessionId: string;
};

type ActiveSessionRow = {
  tenantKey: string;
  chatId: string;
  activeSessionId?: string | null;
  createdBy?: string | null;
  expiresAt?: Date | null;
  updatedAt?: Date;
};

type ChatConfigRow = {
  id: string;
  tenantKey: string;
  chatId: string;
  defaultWorkDir?: string | null;
  defaultRuntime?: string | null;
};

type MessageRow = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  contentType: string;
};

type DiscussionRow = {
  id: string;
  sessionId: string;
  status: string;
  roundLimit?: number;
  currentRound?: number;
  currentTurnIndex?: number;
  completedAt?: Date | null;
  updatedAt?: Date;
};

function columnToProperty(columnName: string): string {
  return columnName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function createDb() {
  const data = {
    sessions: [] as SessionRow[],
    aliases: [] as SessionAliasRow[],
    activeSessions: [] as ActiveSessionRow[],
    chatConfigs: [] as ChatConfigRow[],
    messages: [] as MessageRow[],
    tasks: [] as Array<Record<string, unknown>>,
    admissionLeases: [] as Array<Record<string, unknown>>,
    waitingContracts: [] as Array<Record<string, unknown>>,
    sharedContextEntries: [] as Array<Record<string, unknown>>,
    agentSessionStates: [] as Array<Record<string, unknown>>,
    discussions: [] as DiscussionRow[],
    discussionParticipants: [] as Array<Record<string, unknown>>,
    discussionTurns: [] as Array<Record<string, unknown>>,
    memoryEntries: [] as Array<Record<string, unknown>>,
    agentDelegations: [] as Array<Record<string, unknown>>,
  };

  let seq = 0;

  const rowsForTable = (table: any) => {
    if (table?.sessionKey) return data.sessions;
    if (table?.aliasKey) return data.aliases;
    if (table?.activeSessionId) return data.activeSessions;
    if (table?.tenantKey && table?.defaultWorkDir) return data.chatConfigs;
    if (table === messages) return data.messages;
    if (table === tasks) return data.tasks;
    if (table === admissionLeases) return data.admissionLeases;
    if (table === waitingContracts) return data.waitingContracts;
    if (table === sharedContextEntries) return data.sharedContextEntries;
    if (table === agentSessionStates) return data.agentSessionStates;
    if (table === discussions) return data.discussions;
    if (table === discussionParticipants) return data.discussionParticipants;
    if (table === discussionTurns) return data.discussionTurns;
    if (table === memoryEntries) return data.memoryEntries;
    if (table === agentDelegations) return data.agentDelegations;
    throw new Error('Unknown table');
  };

  const stringChunkText = (chunk: any): string =>
    Array.isArray(chunk?.value) ? chunk.value.join('') : '';

  const conditionText = (condition: any): string =>
    (condition?.queryChunks ?? []).map(stringChunkText).join('');

  const conditionChildren = (condition: any): any[] =>
    (condition?.queryChunks ?? []).filter((chunk: any) => chunk?.queryChunks);

  const escapeRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const matchesLike = (value: unknown, pattern: unknown): boolean => {
    const source = String(value ?? '');
    const regex = new RegExp(
      `^${String(pattern ?? '')
        .split('%')
        .map((part) => part.split('_').map(escapeRegex).join('.'))
        .join('.*')}$`,
    );
    return regex.test(source);
  };

  const matchesAtomicCondition = (row: Record<string, unknown>, condition: any): boolean => {
    const chunks = condition?.queryChunks ?? [];
    const column = chunks.find((chunk: any) => typeof chunk?.name === 'string');
    if (!column) return true;
    const value = chunks.find(
      (chunk: any) =>
        !chunk?.queryChunks &&
        !Array.isArray(chunk?.value) &&
        typeof chunk?.name !== 'string',
    );
    const expectedValue = value?.value ?? value;
    const rowValue = row[columnToProperty(column.name)];
    if (conditionText(condition).includes(' like ')) {
      return matchesLike(rowValue, expectedValue);
    }
    return rowValue === expectedValue;
  };

  const matchesCondition = (row: Record<string, unknown>, condition: any): boolean => {
    if (!condition) return true;
    const children = conditionChildren(condition);
    const text = conditionText(condition);
    if (children.length > 0) {
      if (text.includes(' or ')) return children.some((child) => matchesCondition(row, child));
      if (text.includes(' and ')) return children.every((child) => matchesCondition(row, child));
      if (children.length === 1) return matchesCondition(row, children[0]);
    }
    return matchesAtomicCondition(row, condition);
  };

  const filterRows = (rows: Array<Record<string, unknown>>, condition: any) => {
    return rows.filter((row) => matchesCondition(row, condition));
  };

  const insertSession = (values: Record<string, unknown>, ignoreConflict: boolean) => {
    const existing = data.sessions.find((row) => row.sessionKey === values.sessionKey);
    if (existing) {
      if (ignoreConflict) return [];
      throw new Error(
        `duplicate key value violates unique constraint "sessions_session_key_unique"`,
      );
    }
    const row: SessionRow = {
      id: `session-${++seq}`,
      sessionKey: values.sessionKey as string,
      chatId: values.chatId as string,
      scope: values.scope as string,
      status: (values.status as string) ?? 'active',
      adhocWorkDir: (values.adhocWorkDir as string | null | undefined) ?? null,
      runtimeBackend: (values.runtimeBackend as string | null | undefined) ?? null,
      worktreePath: (values.worktreePath as string | null | undefined) ?? null,
      projectId: (values.projectId as string | null | undefined) ?? null,
    };
    data.sessions.push(row);
    return [row];
  };

  const db = {
    select() {
      return {
        from(table: any) {
          return {
            where(condition: any) {
              const filtered = filterRows(
                rowsForTable(table) as Array<Record<string, unknown>>,
                condition,
              );
              return {
                limit(limit: number) {
                  return Promise.resolve(filtered.slice(0, limit));
                },
                then(onFulfilled: any, onRejected: any) {
                  return Promise.resolve(filtered).then(onFulfilled, onRejected);
                },
              };
            },
          };
        },
      };
    },
    insert(table: any) {
      return {
        values(values: Record<string, unknown>) {
          if (table?.sessionKey) {
            return {
              onConflictDoNothing() {
                return {
                  async returning() {
                    return insertSession(values, true);
                  },
                };
              },
              async returning() {
                return insertSession(values, false);
              },
            };
          }

          if (table?.aliasKey) {
            return {
              async onConflictDoNothing() {
                const exists = data.aliases.some((row) => row.aliasKey === values.aliasKey);
                if (!exists) {
                  data.aliases.push({
                    id: `alias-${++seq}`,
                    aliasKey: values.aliasKey as string,
                    targetSessionId: values.targetSessionId as string,
                  });
                }
              },
              async onConflictDoUpdate({ set }: { set: Record<string, unknown> }) {
                const existing = data.aliases.find((row) => row.aliasKey === values.aliasKey);
                if (existing) {
                  Object.assign(existing, set);
                  return;
                }
                data.aliases.push({
                  id: `alias-${++seq}`,
                  aliasKey: values.aliasKey as string,
                  targetSessionId: values.targetSessionId as string,
                });
              },
            };
          }

          if (table?.activeSessionId) {
            return {
              async onConflictDoUpdate({ set }: { set: Record<string, unknown> }) {
                const existing = data.activeSessions.find(
                  (row) =>
                    row.tenantKey === ((values.tenantKey as string | undefined) ?? 'default') &&
                    row.chatId === values.chatId,
                );
                if (existing) {
                  Object.assign(existing, set);
                  return;
                }
                data.activeSessions.push({
                  tenantKey: (values.tenantKey as string | undefined) ?? 'default',
                  chatId: values.chatId as string,
                  activeSessionId: (values.activeSessionId as string | undefined) ?? null,
                  createdBy: (values.createdBy as string | undefined) ?? null,
                  expiresAt: (values.expiresAt as Date | undefined) ?? null,
                  updatedAt: new Date(),
                });
              },
            };
          }

          throw new Error('Unknown insert table');
        },
      };
    },
    delete(table: any) {
      return {
        async where(condition: any) {
          const rows = rowsForTable(table) as Array<Record<string, unknown>>;
          const matches = new Set(filterRows(rows, condition));
          rows.splice(0, rows.length, ...rows.filter((row) => !matches.has(row as never)));
        },
      };
    },
    update(table: any) {
      return {
        set(values: Record<string, unknown>) {
          return {
            async where(condition: any) {
              const rows = rowsForTable(table) as Array<Record<string, unknown>>;
              const matches = filterRows(rows, condition);
              for (const row of matches) {
                Object.assign(row, values);
              }
            },
          };
        },
      };
    },
    async transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      return callback(db);
    },
  };

  return { db: db as any, data };
}

function createEvent(
  overrides: Partial<NormalizedEvent> & {
    content?: Partial<NormalizedEvent['content']>;
  } = {},
): NormalizedEvent {
  return {
    eventId: overrides.eventId ?? 'evt_001',
    messageId: overrides.messageId ?? 'om_root_001',
    chatId: overrides.chatId ?? 'chat_001',
    chatType: overrides.chatType ?? 'p2p',
    threadId: overrides.threadId,
    rootMessageId: overrides.rootMessageId,
    parentMessageId: overrides.parentMessageId,
    senderOpenId: overrides.senderOpenId ?? 'ou_user_001',
    tenantKey: overrides.tenantKey ?? 'tenant_001',
    content: {
      type: overrides.content?.type ?? 'text',
      text: overrides.content?.text ?? 'hello',
      mentions: overrides.content?.mentions ?? [],
      raw: overrides.content?.raw ?? {},
      command: overrides.content?.command,
      args: overrides.content?.args,
      imageKey: overrides.content?.imageKey,
      imageMessageId: overrides.content?.imageMessageId,
      referencedMessages: overrides.content?.referencedMessages,
    },
    timestamp: overrides.timestamp ?? Date.now(),
  };
}

describe('resolveSession', () => {
  it('creates a manual session for /new commands', async () => {
    const { db } = createDb();

    const result = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        content: { type: 'command', command: '/new', args: '' },
      }),
    );

    expect(result.scope).toBe('group-manual');
    expect(result.isNew).toBe(true);
    expect(result.sessionKey).toContain(':manual:');
  });

  it('does not create an active manual session for /new --help', async () => {
    const { db, data } = createDb();

    const result = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        content: { type: 'command', command: '/new', args: '--help' },
      }),
    );

    expect(result.scope).toBe('thread');
    expect(result.sessionKey).toContain(':bootstrap:');
    expect(data.activeSessions).toHaveLength(0);
  });

  it('routes /reset commands back to the group main session', async () => {
    const { db } = createDb();

    await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        content: { type: 'command', command: '/new', args: '' },
      }),
    );

    const reset = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        eventId: 'evt_reset',
        messageId: 'om_reset_001',
        content: { type: 'command', command: '/reset', args: '' },
      }),
    );

    expect(reset.sessionKey).toBe('feishu:tenant_001:chat_group:group:main');
    expect(reset.scope).toBe('group-main');
  });

  it('does not clear the active manual session for /reset --help', async () => {
    const { db, data } = createDb();

    const manual = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        content: { type: 'command', command: '/new', args: '' },
      }),
    );

    const help = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        eventId: 'evt_reset_help',
        messageId: 'om_reset_help_001',
        content: { type: 'command', command: '/reset', args: '--help' },
      }),
    );

    expect(help.sessionId).toBe(manual.sessionId);
    expect(data.activeSessions).toHaveLength(1);
    expect(data.activeSessions[0].activeSessionId).toBe(manual.sessionId);
  });

  it('keeps manual active sessions isolated across tenants with the same chat id', async () => {
    const { db } = createDb();

    const tenantA = await resolveSession(
      db,
      createEvent({
        tenantKey: 'tenant_a',
        chatType: 'group',
        chatId: 'shared_chat',
        content: { type: 'command', command: '/new', args: '' },
      }),
    );
    const tenantB = await resolveSession(
      db,
      createEvent({
        tenantKey: 'tenant_b',
        chatType: 'group',
        chatId: 'shared_chat',
        eventId: 'evt_tenant_b_new',
        messageId: 'om_tenant_b_new',
        content: { type: 'command', command: '/new', args: '' },
      }),
    );

    const tenantAFollowUp = await resolveSession(
      db,
      createEvent({
        tenantKey: 'tenant_a',
        chatType: 'group',
        chatId: 'shared_chat',
        eventId: 'evt_tenant_a_followup',
        messageId: 'om_tenant_a_followup',
      }),
    );
    const tenantBFollowUp = await resolveSession(
      db,
      createEvent({
        tenantKey: 'tenant_b',
        chatType: 'group',
        chatId: 'shared_chat',
        eventId: 'evt_tenant_b_followup',
        messageId: 'om_tenant_b_followup',
      }),
    );

    expect(tenantAFollowUp.sessionId).toBe(tenantA.sessionId);
    expect(tenantBFollowUp.sessionId).toBe(tenantB.sessionId);
  });

  it('reuses the same session for repeated group thread messages', async () => {
    const { db } = createDb();

    const first = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        threadId: 'om_thread_001',
      }),
    );
    const second = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        eventId: 'evt_thread_002',
        messageId: 'om_thread_reply_002',
        threadId: 'om_thread_001',
      }),
    );

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.isNew).toBe(false);
  });

  it('creates a provisional thread session for a root private message', async () => {
    const { db } = createDb();

    const result = await resolveSession(
      db,
      createEvent({
        chatType: 'p2p',
        chatId: 'chat_p2p',
        messageId: 'om_dm_root_001',
      }),
    );

    expect(result).toMatchObject({
      sessionKey: 'feishu:tenant_001:chat_p2p:bootstrap:om_dm_root_001',
      scope: 'thread',
      isNew: true,
    });
  });

  it('resolves concurrent group root events with the same message id to one bootstrap session', async () => {
    const { db, data } = createDb();
    const firstEvent = createEvent({
      chatType: 'group',
      chatId: 'chat_group',
      messageId: 'om_gaokao_root_001',
      eventId: 'evt_r2d2',
      content: {
        type: 'text',
        text: '@R2D2 @性能成本小助手 你们俩讨论一下今天的中国高考情况',
        mentions: [
          { id: 'ou_r2d2', name: 'R2D2', isBot: true },
          { id: 'ou_perf', name: '性能成本小助手', isBot: true },
        ],
      },
    });
    const secondEvent = createEvent({
      ...firstEvent,
      eventId: 'evt_perf',
    });

    const [first, second] = await Promise.all([
      resolveSession(db, firstEvent),
      resolveSession(db, secondEvent),
    ]);

    expect(first.sessionKey).toBe(
      'feishu:tenant_001:chat_group:bootstrap:om_gaokao_root_001',
    );
    expect(second.sessionKey).toBe(first.sessionKey);
    expect(second.sessionId).toBe(first.sessionId);
    expect(data.sessions).toHaveLength(1);
  });

  it('bootstraps a group topic from the current message for parent-only quoted roots', async () => {
    const { db } = createDb();

    const result = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_group_quote_root_001',
        parentMessageId: 'om_quoted_image_001',
      }),
    );

    expect(result).toMatchObject({
      sessionKey: 'feishu:tenant_001:chat_group:bootstrap:om_group_quote_root_001',
      scope: 'thread',
      isNew: true,
    });
  });

  it('does not bind a quoted image topic start to the referenced image thread id', async () => {
    const { db } = createDb();

    const result = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_group_quote_request_001',
        threadId: 'om_quoted_image_002',
        rootMessageId: 'om_quoted_image_002',
        parentMessageId: 'om_quoted_image_002',
        content: {
          type: 'text',
          referencedMessages: [
            {
              messageId: 'om_quoted_image_002',
              contentType: 'image',
              entries: [],
              imageAttachment: {
                imageKey: 'img_quoted_002',
                messageId: 'om_quoted_image_002',
              },
            },
          ],
        },
      }),
    );

    expect(result).toMatchObject({
      sessionKey: 'feishu:tenant_001:chat_group:bootstrap:om_group_quote_request_001',
      scope: 'thread',
      isNew: true,
    });
  });

  it('does not bind group sessions to the current message id when Feishu reports it as thread id', async () => {
    const { db } = createDb();

    const result = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_current_topic_probe_001',
        threadId: 'om_current_topic_probe_001',
      }),
    );

    expect(result).toMatchObject({
      sessionKey: 'feishu:tenant_001:chat_group:bootstrap:om_current_topic_probe_001',
      scope: 'thread',
      isNew: true,
    });
  });

  it('merges a race-created generated topic session back into the quoted image bootstrap session', async () => {
    const { db, data } = createDb();
    const rootEvent = createEvent({
      chatType: 'group',
      chatId: 'chat_group',
      messageId: 'om_group_quote_request_002',
      content: {
        type: 'text',
        referencedMessages: [
          {
            messageId: 'om_quoted_image_003',
            contentType: 'image',
            entries: [],
            imageAttachment: {
              imageKey: 'img_quoted_003',
              messageId: 'om_quoted_image_003',
            },
          },
        ],
      },
    });
    const original = await resolveSession(db, rootEvent);
    const split = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_followup_002',
        threadId: 'omt_generated_topic_002',
        rootMessageId: 'om_group_quote_request_002',
      }),
    );
    data.messages.push({
      id: 'message-1',
      sessionId: split.sessionId,
      role: 'user',
      content: 'follow-up in raced session',
      contentType: 'text',
    });

    await aliasThreadKeysForSession(
      db,
      original.sessionId,
      'omt_generated_topic_002',
      rootEvent.tenantKey,
      rootEvent.chatId,
    );

    expect(data.messages[0].sessionId).toBe(original.sessionId);
    expect(await canonicalizeSessionId(db, split.sessionId)).toBe(original.sessionId);
    expect(
      data.aliases.find(
        (alias) =>
          alias.aliasKey ===
          'feishu:tenant_001:chat_group:thread:omt_generated_topic_002',
      )?.targetSessionId,
    ).toBe(original.sessionId);
  });

  it('keeps the newer agent runtime state when merging a split topic session', async () => {
    const { db, data } = createDb();
    const older = new Date('2026-06-15T10:00:00.000Z');
    const newer = new Date('2026-06-15T11:00:00.000Z');
    const original = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_group_quote_request_state_001',
      }),
    );
    const split = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_followup_state_001',
        threadId: 'omt_generated_topic_state_001',
      }),
    );

    data.agentSessionStates.push(
      {
        id: 'agent-state-target',
        agentId: 'agent-1',
        sessionId: original.sessionId,
        runtimeBackend: 'claude_code',
        sdkSessionId: 'sdk-old',
        sdkSessionMachineId: 'machine-old',
        workspacePath: '/workspace/old',
        updatedAt: older,
        createdAt: older,
        lastRunAt: older,
      },
      {
        id: 'agent-state-source',
        agentId: 'agent-1',
        sessionId: split.sessionId,
        runtimeBackend: 'claude_code',
        sdkSessionId: 'sdk-new',
        sdkSessionMachineId: 'machine-new',
        workspacePath: '/workspace/new',
        updatedAt: newer,
        createdAt: newer,
        lastRunAt: newer,
      },
    );

    await aliasThreadKeysForSession(
      db,
      original.sessionId,
      'omt_generated_topic_state_001',
      'tenant_001',
      'chat_group',
    );

    expect(data.agentSessionStates).toHaveLength(1);
    expect(data.agentSessionStates[0]).toMatchObject({
      id: 'agent-state-target',
      sessionId: original.sessionId,
      sdkSessionId: 'sdk-new',
      sdkSessionMachineId: 'machine-new',
      workspacePath: '/workspace/new',
      lastRunAt: newer,
    });
  });

  it('moves a split discussion onto the canonical topic session', async () => {
    const { db, data } = createDb();
    const original = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_group_quote_request_discussion_001',
      }),
    );
    const split = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_followup_discussion_001',
        threadId: 'omt_generated_topic_discussion_001',
      }),
    );
    data.discussions.push({
      id: 'discussion-1',
      sessionId: split.sessionId,
      status: 'active',
      completedAt: null,
    });

    await aliasThreadKeysForSession(
      db,
      original.sessionId,
      'omt_generated_topic_discussion_001',
      'tenant_001',
      'chat_group',
    );

    expect(data.discussions).toHaveLength(1);
    expect(data.discussions[0]).toMatchObject({
      id: 'discussion-1',
      sessionId: original.sessionId,
      status: 'active',
      completedAt: null,
    });
  });

  it('moves split-session memory scopes and delegation links onto the canonical session', async () => {
    const { db, data } = createDb();
    const original = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_group_quote_request_memory_001',
      }),
    );
    const split = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_followup_memory_001',
        threadId: 'omt_generated_topic_memory_001',
      }),
    );

    data.memoryEntries.push(
      {
        id: 'memory-session',
        scopeType: 'session',
        scopeId: split.sessionId,
        memoryType: 'summary',
        content: 'split session memory',
      },
      {
        id: 'memory-agent-session',
        scopeType: 'agent_session',
        scopeId: `agent-1:${split.sessionId}`,
        memoryType: 'preference',
        content: 'split agent session memory',
      },
      {
        id: 'memory-other',
        scopeType: 'agent_session',
        scopeId: 'agent-1:session-unrelated',
        memoryType: 'preference',
        content: 'unrelated memory',
      },
    );
    data.agentDelegations.push({
      id: 'delegation-1',
      childSessionId: split.sessionId,
      status: 'running',
    });

    await aliasThreadKeysForSession(
      db,
      original.sessionId,
      'omt_generated_topic_memory_001',
      'tenant_001',
      'chat_group',
    );

    expect(data.memoryEntries.find((row) => row.id === 'memory-session')?.scopeId).toBe(
      original.sessionId,
    );
    expect(data.memoryEntries.find((row) => row.id === 'memory-agent-session')?.scopeId).toBe(
      `agent-1:${original.sessionId}`,
    );
    expect(data.memoryEntries.find((row) => row.id === 'memory-other')?.scopeId).toBe(
      'agent-1:session-unrelated',
    );
    expect(data.agentDelegations[0].childSessionId).toBe(original.sessionId);
  });

  it('remaps matching agent-session memories even after many unrelated rows', async () => {
    const { db, data } = createDb();
    const original = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_group_quote_request_many_memory_001',
      }),
    );
    const split = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_followup_many_memory_001',
        threadId: 'omt_generated_topic_many_memory_001',
      }),
    );

    for (let index = 0; index < 1005; index += 1) {
      data.memoryEntries.push({
        id: `memory-unrelated-${index}`,
        scopeType: 'agent_session',
        scopeId: `agent-1:session-unrelated-${index}`,
        memoryType: 'preference',
        content: 'unrelated memory',
      });
    }
    data.memoryEntries.push({
      id: 'memory-matching-after-unrelated',
      scopeType: 'agent_session',
      scopeId: `agent-1:${split.sessionId}`,
      memoryType: 'preference',
      content: 'matching split memory',
    });

    await aliasThreadKeysForSession(
      db,
      original.sessionId,
      'omt_generated_topic_many_memory_001',
      'tenant_001',
      'chat_group',
    );

    expect(
      data.memoryEntries.find((row) => row.id === 'memory-matching-after-unrelated')?.scopeId,
    ).toBe(`agent-1:${original.sessionId}`);
    expect(data.memoryEntries.find((row) => row.id === 'memory-unrelated-1004')?.scopeId).toBe(
      'agent-1:session-unrelated-1004',
    );
  });

  it('merges conflicting discussion rows instead of losing source turns and task constraints', async () => {
    const { db, data } = createDb();
    const original = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_group_quote_request_discussion_conflict_001',
      }),
    );
    const split = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_followup_discussion_conflict_001',
        threadId: 'omt_generated_topic_discussion_conflict_001',
      }),
    );

    data.discussions.push(
      {
        id: 'discussion-target',
        sessionId: original.sessionId,
        status: 'active',
        roundLimit: 3,
        currentRound: 1,
        currentTurnIndex: 0,
        completedAt: null,
      },
      {
        id: 'discussion-source',
        sessionId: split.sessionId,
        status: 'active',
        roundLimit: 3,
        currentRound: 1,
        currentTurnIndex: 1,
        completedAt: null,
      },
    );
    data.discussionParticipants.push(
      {
        id: 'participant-target-a',
        discussionId: 'discussion-target',
        agentId: 'agent-a',
        orderIndex: 0,
      },
      {
        id: 'participant-source-a',
        discussionId: 'discussion-source',
        agentId: 'agent-a',
        orderIndex: 0,
      },
      {
        id: 'participant-source-b',
        discussionId: 'discussion-source',
        agentId: 'agent-b',
        orderIndex: 1,
      },
    );
    data.discussionTurns.push(
      {
        id: 'turn-target',
        discussionId: 'discussion-target',
        participantId: 'participant-target-a',
        agentId: 'agent-a',
        taskId: 'task-target',
        round: 1,
        turnIndex: 0,
        status: 'completed',
        content: 'target answer',
        createdAt: new Date('2026-06-15T10:00:00.000Z'),
      },
      {
        id: 'turn-source',
        discussionId: 'discussion-source',
        participantId: 'participant-source-b',
        agentId: 'agent-b',
        taskId: 'task-source',
        round: 1,
        turnIndex: 0,
        status: 'queued',
        content: null,
        createdAt: new Date('2026-06-15T10:01:00.000Z'),
      },
    );
    data.tasks.push({
      id: 'task-source',
      sessionId: split.sessionId,
      constraints: { discussionId: 'discussion-source', keep: true },
    });
    data.admissionLeases.push({
      taskId: 'task-source',
      sessionId: split.sessionId,
      jobData: { constraints: { discussionId: 'discussion-source', keep: true } },
    });

    await aliasThreadKeysForSession(
      db,
      original.sessionId,
      'omt_generated_topic_discussion_conflict_001',
      'tenant_001',
      'chat_group',
    );

    expect(data.discussions.find((row) => row.id === 'discussion-source')?.status).toBe(
      'cancelled',
    );
    expect(data.discussions.find((row) => row.id === 'discussion-target')).toMatchObject({
      status: 'active',
      currentTurnIndex: 1,
    });
    expect(
      data.discussionParticipants.find((row) => row.id === 'participant-source-b'),
    ).toMatchObject({
      discussionId: 'discussion-target',
      orderIndex: 1,
    });
    expect(data.discussionTurns.find((row) => row.id === 'turn-source')).toMatchObject({
      discussionId: 'discussion-target',
      participantId: 'participant-source-b',
      round: 1,
      turnIndex: 1,
    });
    expect(data.tasks.find((row) => row.id === 'task-source')).toMatchObject({
      sessionId: original.sessionId,
      constraints: { discussionId: 'discussion-target', keep: true },
    });
    expect(data.admissionLeases.find((row) => row.taskId === 'task-source')).toMatchObject({
      sessionId: original.sessionId,
      jobData: { constraints: { discussionId: 'discussion-target', keep: true } },
    });
  });

  it('keeps a valid discussion cursor and rolls appended conflicting turns across rounds', async () => {
    const { db, data } = createDb();
    const original = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_group_quote_request_discussion_round_001',
      }),
    );
    const split = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group',
        messageId: 'om_followup_discussion_round_001',
        threadId: 'omt_generated_topic_discussion_round_001',
      }),
    );

    data.discussions.push(
      {
        id: 'discussion-target-round',
        sessionId: original.sessionId,
        status: 'active',
        roundLimit: 3,
        currentRound: 2,
        currentTurnIndex: 0,
        completedAt: null,
      },
      {
        id: 'discussion-source-round',
        sessionId: split.sessionId,
        status: 'active',
        roundLimit: 3,
        currentRound: 1,
        currentTurnIndex: 1,
        completedAt: null,
      },
    );
    data.discussionParticipants.push(
      {
        id: 'participant-round-target-a',
        discussionId: 'discussion-target-round',
        agentId: 'agent-a',
        orderIndex: 0,
      },
      {
        id: 'participant-round-target-b',
        discussionId: 'discussion-target-round',
        agentId: 'agent-b',
        orderIndex: 1,
      },
      {
        id: 'participant-round-source-a',
        discussionId: 'discussion-source-round',
        agentId: 'agent-a',
        orderIndex: 0,
      },
      {
        id: 'participant-round-source-b',
        discussionId: 'discussion-source-round',
        agentId: 'agent-b',
        orderIndex: 1,
      },
    );
    data.discussionTurns.push(
      {
        id: 'turn-round-target-a',
        discussionId: 'discussion-target-round',
        participantId: 'participant-round-target-a',
        agentId: 'agent-a',
        taskId: 'task-round-target-a',
        round: 1,
        turnIndex: 0,
        status: 'completed',
        content: 'target a',
        createdAt: new Date('2026-06-15T10:00:00.000Z'),
      },
      {
        id: 'turn-round-target-b',
        discussionId: 'discussion-target-round',
        participantId: 'participant-round-target-b',
        agentId: 'agent-b',
        taskId: 'task-round-target-b',
        round: 1,
        turnIndex: 1,
        status: 'completed',
        content: 'target b',
        createdAt: new Date('2026-06-15T10:01:00.000Z'),
      },
      {
        id: 'turn-round-source-a',
        discussionId: 'discussion-source-round',
        participantId: 'participant-round-source-a',
        agentId: 'agent-a',
        taskId: 'task-round-source-a',
        round: 1,
        turnIndex: 0,
        status: 'completed',
        content: 'source a',
        createdAt: new Date('2026-06-15T10:02:00.000Z'),
      },
      {
        id: 'turn-round-source-b',
        discussionId: 'discussion-source-round',
        participantId: 'participant-round-source-b',
        agentId: 'agent-b',
        taskId: 'task-round-source-b',
        round: 1,
        turnIndex: 1,
        status: 'queued',
        content: null,
        createdAt: new Date('2026-06-15T10:03:00.000Z'),
      },
    );

    await aliasThreadKeysForSession(
      db,
      original.sessionId,
      'omt_generated_topic_discussion_round_001',
      'tenant_001',
      'chat_group',
    );

    expect(data.discussions.find((row) => row.id === 'discussion-target-round')).toMatchObject({
      currentRound: 2,
      currentTurnIndex: 0,
    });
    expect(data.discussionTurns.find((row) => row.id === 'turn-round-source-a')).toMatchObject({
      discussionId: 'discussion-target-round',
      participantId: 'participant-round-target-a',
      round: 2,
      turnIndex: 0,
    });
    expect(data.discussionTurns.find((row) => row.id === 'turn-round-source-b')).toMatchObject({
      discussionId: 'discussion-target-round',
      participantId: 'participant-round-target-b',
      round: 2,
      turnIndex: 1,
    });
  });

  it('reuses an existing group topic when a follow-up carries only parentMessageId', async () => {
    const { db } = createDb();
    const rootEvent = createEvent({
      chatType: 'group',
      chatId: 'chat_group_topic',
      messageId: 'om_group_root_002',
    });

    const initial = await resolveSession(db, rootEvent);
    await upgradeProvisionalSession(
      db,
      initial.sessionKey,
      ['om_group_root_002', 'om_bot_reply_group_002'],
      rootEvent.tenantKey,
      rootEvent.chatId,
    );

    const followUp = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group_topic',
        messageId: 'om_group_reply_parent_only_001',
        eventId: 'evt_group_parent_only_followup',
        parentMessageId: 'om_group_root_002',
      }),
    );

    expect(followUp.sessionId).toBe(initial.sessionId);
    expect(followUp.isNew).toBe(false);
  });

  it('creates a distinct provisional session for each new root private message', async () => {
    const { db } = createDb();

    const first = await resolveSession(
      db,
      createEvent({
        chatType: 'p2p',
        chatId: 'chat_p2p',
        messageId: 'om_dm_root_001',
      }),
    );
    const second = await resolveSession(
      db,
      createEvent({
        chatType: 'p2p',
        chatId: 'chat_p2p',
        messageId: 'om_dm_root_002',
        eventId: 'evt_002',
      }),
    );

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.sessionKey).not.toBe(second.sessionKey);
  });

  it('reuses the same session for follow-up messages in a private-chat topic', async () => {
    const { db } = createDb();
    const rootEvent = createEvent({
      chatType: 'p2p',
      chatId: 'chat_p2p',
      messageId: 'om_dm_root_001',
    });

    const initial = await resolveSession(db, rootEvent);
    await upgradeProvisionalSession(
      db,
      initial.sessionKey,
      rootEvent.messageId,
      rootEvent.tenantKey,
      rootEvent.chatId,
    );

    const followUp = await resolveSession(
      db,
      createEvent({
        chatType: 'p2p',
        chatId: 'chat_p2p',
        messageId: 'om_dm_reply_001',
        eventId: 'evt_003',
        threadId: rootEvent.messageId,
      }),
    );

    expect(followUp.sessionId).toBe(initial.sessionId);
    expect(followUp.scope).toBe('thread');
    expect(followUp.isNew).toBe(false);
  });

  it('reuses the session when rootMessageId points at the first bot reply', async () => {
    const { db } = createDb();
    const rootEvent = createEvent({
      chatType: 'p2p',
      chatId: 'chat_p2p',
      messageId: 'om_dm_root_001',
    });

    const initial = await resolveSession(db, rootEvent);
    await upgradeProvisionalSession(
      db,
      initial.sessionKey,
      ['om_dm_root_001', 'om_bot_reply_001'],
      rootEvent.tenantKey,
      rootEvent.chatId,
    );

    const followUp = await resolveSession(
      db,
      createEvent({
        chatType: 'p2p',
        chatId: 'chat_p2p',
        messageId: 'om_dm_reply_002',
        eventId: 'evt_004',
        threadId: 'thread_generated_by_feishu',
        rootMessageId: 'om_bot_reply_001',
      }),
    );

    expect(followUp.sessionId).toBe(initial.sessionId);
    expect(followUp.isNew).toBe(false);
  });

  it('reuses the session when parentMessageId points at the first bot reply', async () => {
    const { db } = createDb();
    const rootEvent = createEvent({
      chatType: 'p2p',
      chatId: 'chat_p2p',
      messageId: 'om_dm_root_001',
    });

    const initial = await resolveSession(db, rootEvent);
    await upgradeProvisionalSession(
      db,
      initial.sessionKey,
      ['om_dm_root_001', 'om_bot_reply_001'],
      rootEvent.tenantKey,
      rootEvent.chatId,
    );

    const followUp = await resolveSession(
      db,
      createEvent({
        chatType: 'p2p',
        chatId: 'chat_p2p',
        messageId: 'om_dm_reply_003',
        eventId: 'evt_005',
        parentMessageId: 'om_bot_reply_001',
      }),
    );

    expect(followUp.sessionId).toBe(initial.sessionId);
    expect(followUp.isNew).toBe(false);
  });

  it('reuses a group root session when the topic follow-up carries only rootMessageId', async () => {
    // Group root @bot creates a bootstrap session; the API alias-upgrades the
    // bot reply ids onto thread keys; a quoted-reply follow-up that Feishu
    // delivers with only root_id (no thread_id) must still resolve back to
    // the original session via the alias path.
    const { db } = createDb();
    const rootEvent = createEvent({
      chatType: 'group',
      chatId: 'chat_group_topic',
      messageId: 'om_group_root_001',
    });

    const initial = await resolveSession(db, rootEvent);
    await upgradeProvisionalSession(
      db,
      initial.sessionKey,
      ['om_group_root_001', 'om_bot_reply_group_001'],
      rootEvent.tenantKey,
      rootEvent.chatId,
    );

    const followUp = await resolveSession(
      db,
      createEvent({
        chatType: 'group',
        chatId: 'chat_group_topic',
        messageId: 'om_group_reply_001',
        eventId: 'evt_group_followup',
        rootMessageId: 'om_group_root_001',
      }),
    );

    expect(followUp.sessionId).toBe(initial.sessionId);
    expect(followUp.isNew).toBe(false);
  });

  describe('OPEN_TAG_DEFAULT_WORKDIR', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.OPEN_TAG_DEFAULT_WORKDIR;
      delete process.env.OPEN_TAG_DEFAULT_WORKDIR;
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.OPEN_TAG_DEFAULT_WORKDIR;
      } else {
        process.env.OPEN_TAG_DEFAULT_WORKDIR = originalEnv;
      }
    });

    it('seeds adhocWorkDir on new sessions when the env var is set', async () => {
      process.env.OPEN_TAG_DEFAULT_WORKDIR = '/tmp/demo';
      const { db, data } = createDb();

      const result = await resolveSession(
        db,
        createEvent({
          chatType: 'p2p',
          chatId: 'chat_p2p',
          messageId: 'om_dm_root_001',
        }),
      );

      expect(result.isNew).toBe(true);
      const created = data.sessions.find((row) => row.id === result.sessionId);
      expect(created?.adhocWorkDir).toBe('/tmp/demo');
    });

    it('leaves adhocWorkDir null when the env var is unset', async () => {
      const { db, data } = createDb();

      const result = await resolveSession(
        db,
        createEvent({
          chatType: 'p2p',
          chatId: 'chat_p2p',
          messageId: 'om_dm_root_001',
        }),
      );

      expect(result.isNew).toBe(true);
      const created = data.sessions.find((row) => row.id === result.sessionId);
      expect(created?.adhocWorkDir).toBeNull();
    });

    it('treats whitespace-only env values as unset', async () => {
      process.env.OPEN_TAG_DEFAULT_WORKDIR = '   ';
      const { db, data } = createDb();

      const result = await resolveSession(
        db,
        createEvent({
          chatType: 'p2p',
          chatId: 'chat_p2p',
          messageId: 'om_dm_root_001',
        }),
      );

      const created = data.sessions.find((row) => row.id === result.sessionId);
      expect(created?.adhocWorkDir).toBeNull();
    });

    it('ignores relative paths and stores null', async () => {
      process.env.OPEN_TAG_DEFAULT_WORKDIR = 'relative/path';
      const { db, data } = createDb();

      const result = await resolveSession(
        db,
        createEvent({
          chatType: 'p2p',
          chatId: 'chat_p2p',
          messageId: 'om_dm_root_001',
        }),
      );

      const created = data.sessions.find((row) => row.id === result.sessionId);
      expect(created?.adhocWorkDir).toBeNull();
    });

    it('seeds existing unbound sessions when the env var is set later', async () => {
      const { db, data } = createDb();

      const first = await resolveSession(
        db,
        createEvent({
          chatType: 'group',
          chatId: 'chat_group',
          threadId: 'om_thread_001',
        }),
      );

      process.env.OPEN_TAG_DEFAULT_WORKDIR = '/tmp/demo';

      const second = await resolveSession(
        db,
        createEvent({
          chatType: 'group',
          chatId: 'chat_group',
          eventId: 'evt_thread_002',
          messageId: 'om_thread_reply_002',
          threadId: 'om_thread_001',
        }),
      );

      expect(second.sessionId).toBe(first.sessionId);
      const existing = data.sessions.find((row) => row.id === first.sessionId);
      expect(existing?.adhocWorkDir).toBe('/tmp/demo');
    });

    it('seeds existing group-main sessions reached through reset', async () => {
      const { db, data } = createDb();

      const first = await resolveSession(
        db,
        createEvent({
          chatType: 'group',
          chatId: 'chat_group',
          content: { type: 'command', command: '/reset', args: '' },
        }),
      );

      process.env.OPEN_TAG_DEFAULT_WORKDIR = '/tmp/demo';

      const second = await resolveSession(
        db,
        createEvent({
          chatType: 'group',
          chatId: 'chat_group',
          eventId: 'evt_reset_002',
          messageId: 'om_reset_002',
          content: { type: 'command', command: '/reset', args: '' },
        }),
      );

      expect(second.sessionId).toBe(first.sessionId);
      const existing = data.sessions.find((row) => row.id === first.sessionId);
      expect(existing?.adhocWorkDir).toBe('/tmp/demo');
    });

    it('does not replace an existing worktree-bound session with the env default', async () => {
      process.env.OPEN_TAG_DEFAULT_WORKDIR = '/tmp/demo';
      const { db, data } = createDb();
      data.sessions.push({
        id: 'session-existing',
        sessionKey: 'feishu:tenant_001:chat_group:thread:om_thread_001',
        chatId: 'chat_group',
        scope: 'thread',
        status: 'active',
        adhocWorkDir: null,
        runtimeBackend: null,
        worktreePath: '/tmp/worktree',
        projectId: null,
      });

      const result = await resolveSession(
        db,
        createEvent({
          chatType: 'group',
          chatId: 'chat_group',
          threadId: 'om_thread_001',
        }),
      );

      expect(result.isNew).toBe(false);
      const existing = data.sessions.find((row) => row.id === result.sessionId);
      expect(existing?.adhocWorkDir).toBeNull();
    });
  });

  it('seeds new sessions from chat defaults before falling back to env defaults', async () => {
    const originalEnv = process.env.OPEN_TAG_DEFAULT_WORKDIR;
    process.env.OPEN_TAG_DEFAULT_WORKDIR = '/tmp/env-default';
    try {
      const { db, data } = createDb();
      data.chatConfigs.push({
        id: 'config-1',
        tenantKey: 'tenant_001',
        chatId: 'chat_group',
        defaultWorkDir: '/tmp/chat-default',
        defaultRuntime: 'codex',
      });

      const result = await resolveSession(
        db,
        createEvent({
          chatType: 'group',
          chatId: 'chat_group',
          messageId: 'om_group_root_001',
        }),
      );

      const created = data.sessions.find((row) => row.id === result.sessionId);
      expect(created?.adhocWorkDir).toBe('/tmp/chat-default');
      // Chat config no longer seeds the runtime: with /chat set-runtime removed,
      // runtime comes from agent/profile defaults and per-task card selection.
      expect(created?.runtimeBackend ?? null).toBeNull();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.OPEN_TAG_DEFAULT_WORKDIR;
      } else {
        process.env.OPEN_TAG_DEFAULT_WORKDIR = originalEnv;
      }
    }
  });

  it('keeps private sessions isolated across tenants', async () => {
    const { db } = createDb();

    const tenantA = await resolveSession(
      db,
      createEvent({
        chatType: 'p2p',
        tenantKey: 'tenant_a',
        chatId: 'chat_p2p',
        messageId: 'om_dm_root_001',
      }),
    );
    const tenantB = await resolveSession(
      db,
      createEvent({
        chatType: 'p2p',
        tenantKey: 'tenant_b',
        chatId: 'chat_p2p',
        eventId: 'evt_tenant_b',
        messageId: 'om_dm_root_001',
      }),
    );

    expect(tenantA.sessionKey).toBe('feishu:tenant_a:chat_p2p:bootstrap:om_dm_root_001');
    expect(tenantB.sessionKey).toBe('feishu:tenant_b:chat_p2p:bootstrap:om_dm_root_001');
    expect(tenantA.sessionId).not.toBe(tenantB.sessionId);
  });
});

// Byte-identity gate: the migrated resolver consumes the neutral InboundMessage but
// MUST still produce the exact same persisted `sessionKey` string for the lark path
// across every session kind, or every existing session would miss on resume. Each
// case adapts a NormalizedEvent through the REAL adapter and pins the literal key —
// covering the one input that is non-lossless on the typed surface (a quoted image's
// id, recovered via channel.native).
describe('resolveSession — lark sessionKey byte-identity (neutral contract)', () => {
  it('keeps a group thread key byte-identical', async () => {
    const { db } = createDb();
    const result = await resolveSessionInbound(
      db,
      adaptNormalizedEvent(
        createEvent({
          chatType: 'group',
          chatId: 'chat_group',
          messageId: 'om_followup_thread_001',
          threadId: 'omt_topic_001',
        }),
      ),
    );
    expect(result.sessionKey).toBe('feishu:tenant_001:chat_group:thread:omt_topic_001');
    expect(result.scope).toBe('thread');
  });

  it('keeps the group main key byte-identical (/reset)', async () => {
    const { db } = createDb();
    const result = await resolveSessionInbound(
      db,
      adaptNormalizedEvent(
        createEvent({
          chatType: 'group',
          chatId: 'chat_group',
          messageId: 'om_reset_main_001',
          content: { type: 'command', command: '/reset', args: '' },
        }),
      ),
    );
    expect(result.sessionKey).toBe('feishu:tenant_001:chat_group:group:main');
    expect(result.scope).toBe('group-main');
  });

  it('keeps a private (DM) bootstrap key byte-identical', async () => {
    const { db } = createDb();
    const result = await resolveSessionInbound(
      db,
      adaptNormalizedEvent(
        createEvent({
          chatType: 'p2p',
          chatId: 'chat_p2p',
          messageId: 'om_dm_root_byte_001',
        }),
      ),
    );
    expect(result.sessionKey).toBe('feishu:tenant_001:chat_p2p:bootstrap:om_dm_root_byte_001');
    expect(result.scope).toBe('thread');
  });

  it('keeps the quoted-image bootstrap key byte-identical (non-lossless native read)', async () => {
    const { db } = createDb();
    const result = await resolveSessionInbound(
      db,
      adaptNormalizedEvent(
        createEvent({
          chatType: 'group',
          chatId: 'chat_group',
          messageId: 'om_group_quote_request_byte_001',
          threadId: 'om_quoted_image_byte_002',
          rootMessageId: 'om_quoted_image_byte_002',
          parentMessageId: 'om_quoted_image_byte_002',
          content: {
            type: 'text',
            referencedMessages: [
              {
                messageId: 'om_quoted_image_byte_002',
                contentType: 'image',
                entries: [],
                imageAttachment: {
                  imageKey: 'img_quoted_byte_002',
                  messageId: 'om_quoted_image_byte_002',
                },
              },
            ],
          },
        }),
      ),
    );
    expect(result.sessionKey).toBe(
      'feishu:tenant_001:chat_group:bootstrap:om_group_quote_request_byte_001',
    );
    expect(result.scope).toBe('thread');
  });
});
