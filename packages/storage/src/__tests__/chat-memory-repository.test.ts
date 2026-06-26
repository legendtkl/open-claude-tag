import { randomUUID } from 'crypto';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildChatMemoryDisablePatch,
  buildChatMemoryEnablePatch,
  buildChatMemoryPromptSection,
  computeNextDailyRunAt,
  DEFAULT_CHAT_MEMORY_SUMMARY_TIME,
  DEFAULT_CHAT_MEMORY_SUMMARY_TIMEZONE,
  listDueChatMemoryConfigs,
  normalizeChatMemoryUpdate,
  parseChatMemoryUpdateBlock,
  selectChatMemoryDetails,
} from '../chat-memory-repository.js';
import type { Database } from '../db.js';
import {
  agentBotBindings,
  agentProfiles,
  agents,
  chatConfigs,
  feishuApps,
} from '../schema.js';
import * as schema from '../schema.js';

describe('chat memory repository helpers', () => {
  it('computes the next daily run in the configured timezone', () => {
    const now = new Date('2026-06-24T01:00:00.000Z'); // 09:00 Asia/Shanghai

    expect(computeNextDailyRunAt(now, '10:30', 'Asia/Shanghai')?.toISOString()).toBe(
      '2026-06-24T02:30:00.000Z',
    );
    expect(computeNextDailyRunAt(now, '08:30', 'Asia/Shanghai')?.toISOString()).toBe(
      '2026-06-25T00:30:00.000Z',
    );
  });

  it('returns null for invalid daily schedule input', () => {
    const now = new Date('2026-06-24T01:00:00.000Z');

    expect(computeNextDailyRunAt(now, '24:00', 'Asia/Shanghai')).toBeNull();
    expect(computeNextDailyRunAt(now, '09:00', 'Not/AZone')).toBeNull();
  });

  it('builds simple enable and disable patches for chat memory', () => {
    const now = new Date('2026-06-24T01:00:00.000Z');

    expect(buildChatMemoryEnablePatch({ agentId: 'agent-1', now })).toMatchObject({
      memoryEnabled: true,
      memorySummaryAgentId: 'agent-1',
      memorySummaryTime: DEFAULT_CHAT_MEMORY_SUMMARY_TIME,
      memorySummaryTimezone: DEFAULT_CHAT_MEMORY_SUMMARY_TIMEZONE,
      memorySummaryNextRunAt: new Date('2026-06-24T01:30:00.000Z'),
      memorySummaryLastStatus: null,
      memorySummaryLastError: null,
    });
    expect(buildChatMemoryEnablePatch({ agentId: null, now })).toMatchObject({
      memoryEnabled: true,
      memorySummaryAgentId: null,
      memorySummaryNextRunAt: new Date('2026-06-24T01:30:00.000Z'),
    });
    expect(buildChatMemoryDisablePatch()).toEqual({
      memoryEnabled: false,
      memorySummaryNextRunAt: null,
      memorySummaryLastStatus: null,
      memorySummaryLastError: null,
    });
  });

  it('parses and normalizes structured chat memory update blocks', () => {
    const output = `
done
<open_claude_tag_chat_memory_update>{
  "index": "Decisions: use isolated e2e for worker changes.",
  "details": [
    {
      "title": "Verification",
      "content": "Run pnpm test:e2e:isolated after starting the isolated API.",
      "keywords": ["e2e", "verification"],
      "importanceScore": 0.9
    }
  ]
}</open_claude_tag_chat_memory_update>`;

    const parsed = parseChatMemoryUpdateBlock(output);
    const normalized = normalizeChatMemoryUpdate(parsed);

    expect(normalized.index.content).toContain('isolated e2e');
    expect(normalized.details).toHaveLength(1);
    expect(normalized.details[0]).toMatchObject({
      title: 'Verification',
      keywords: ['e2e', 'verification'],
      importanceScore: 0.9,
    });
  });

  it('selects relevant details before lower-importance unrelated details', () => {
    const details = [
      {
        id: '1',
        title: 'Release process',
        content: 'Archive design docs before PR.',
        keywords: ['release', 'pr', 'verification'],
        importanceScore: 0.6,
      },
      {
        id: '2',
        title: 'E2E verification',
        content: 'Use isolated API and worker for e2e verification.',
        keywords: ['e2e', 'verification'],
        importanceScore: 0.5,
      },
      {
        id: '3',
        title: 'Unrelated',
        content: 'Low relevance.',
        keywords: ['billing'],
        importanceScore: 1,
      },
    ];

    const selected = selectChatMemoryDetails(details, 'please run e2e verification', {
      maxDetails: 2,
      maxTokens: 200,
    });

    expect(selected.map((entry) => entry.id)).toEqual(['2', '1']);
  });

  it('renders a bounded chat memory section with index and detail hints', () => {
    const section = buildChatMemoryPromptSection({
      index: {
        content: 'Team prefers isolated verification and English PR text.',
        updatedAt: new Date('2026-06-24T00:00:00Z'),
      },
      details: [
        {
          title: 'Verification',
          content: 'Run isolated e2e for worker changes.',
          keywords: ['e2e'],
          importanceScore: 0.8,
        },
      ],
    });

    expect(section).toContain('## Chat Memory Index');
    expect(section).toContain('## Relevant Chat Memory Details');
    expect(section).toContain('Run isolated e2e');
  });
});

const describePg =
  process.env.OPEN_TAG_STORAGE_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('chat memory repository integration', () => {
  let client: postgres.Sql;
  let db: Database;
  const profileIds: string[] = [];
  const agentIds: string[] = [];
  const feishuAppIds: string[] = [];
  const tenantKeys: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for storage Postgres integration tests');
    }
    client = postgres(process.env.DATABASE_URL, {
      max: 5,
      idle_timeout: 5,
      connect_timeout: 5,
    });
    db = drizzle(client, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    if (tenantKeys.length) {
      await db.delete(chatConfigs).where(inArray(chatConfigs.tenantKey, tenantKeys));
    }
    if (agentIds.length) {
      await db.delete(agentBotBindings).where(inArray(agentBotBindings.agentId, agentIds));
    }
    if (feishuAppIds.length) {
      await db.delete(feishuApps).where(inArray(feishuApps.id, feishuAppIds));
    }
    if (agentIds.length) {
      await db.delete(agents).where(inArray(agents.id, agentIds));
    }
    if (profileIds.length) {
      await db.delete(agentProfiles).where(inArray(agentProfiles.id, profileIds));
    }
    await client.end({ timeout: 5 });
  });

  it('falls back from an inactive summary agent to the active chat default agent', async () => {
    const suffix = randomUUID();
    const tenantKey = `tenant_chat_memory_${suffix}`;
    const chatId = `oc_chat_memory_${suffix}`;
    const profileId = randomUUID();
    const inactiveSummaryAgentId = randomUUID();
    const defaultAgentId = randomUUID();
    const feishuAppId = randomUUID();
    profileIds.push(profileId);
    agentIds.push(inactiveSummaryAgentId, defaultAgentId);
    feishuAppIds.push(feishuAppId);
    tenantKeys.push(tenantKey);

    await db.insert(agentProfiles).values({
      id: profileId,
      name: `chat-memory-profile-${suffix}`,
      displayName: 'Chat Memory Test Profile',
    });
    await db.insert(agents).values([
      {
        id: inactiveSummaryAgentId,
        tenantKey,
        handle: `summary-${suffix}`,
        displayName: 'Inactive Summary Agent',
        profileId,
        status: 'disabled',
      },
      {
        id: defaultAgentId,
        tenantKey,
        handle: `default-${suffix}`,
        displayName: 'Default Chat Agent',
        profileId,
        defaultRuntime: 'codex',
        status: 'active',
      },
    ]);
    await db.insert(feishuApps).values({
      id: feishuAppId,
      tenantKey,
      appId: `cli_chat_memory_${suffix}`,
      appSecretRef: `env:CHAT_MEMORY_${suffix}`,
      status: 'enabled',
    });
    await db.insert(agentBotBindings).values({
      agentId: defaultAgentId,
      feishuAppId,
      status: 'active',
    });
    await db.insert(chatConfigs).values({
      tenantKey,
      chatId,
      defaultAgentId,
      memoryEnabled: true,
      memorySummaryAgentId: inactiveSummaryAgentId,
      memorySummaryNextRunAt: new Date('2026-06-23T00:00:00.000Z'),
    });

    const rows = await listDueChatMemoryConfigs(db, {
      now: new Date('2026-06-24T00:00:00.000Z'),
      limit: 10,
    });

    expect(rows).toContainEqual(
      expect.objectContaining({
        tenantKey,
        chatId,
        memorySummaryAgentId: defaultAgentId,
        agentStatus: 'active',
        agentDefaultRuntime: 'codex',
        feishuAppId,
      }),
    );
  });
});
