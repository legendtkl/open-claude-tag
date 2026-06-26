import { randomUUID } from 'crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, memoryEntries } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import { MemoryHandler } from '../memory-handler.js';

// Real-Postgres TTL behavior: ttl_at was a dead column — expired entries were
// retrieved forever.
// Gated STRICTLY on the package integration flag (set by the test:integration
// script): a developer shell that merely exports DATABASE_URL must not have
// plain unit runs hit a real database.
const describePg = process.env.OPEN_TAG_MEMORY_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('memory handler integration (ttl)', () => {
  let db: Database;
  let handler: MemoryHandler;
  const scopeId = `scope-${randomUUID()}`;
  const entryIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for memory Postgres integration tests');
    }
    db = createDb(process.env.DATABASE_URL);
    handler = new MemoryHandler(db);
  });

  afterAll(async () => {
    if (entryIds.length) {
      await db.delete(memoryEntries).where(inArray(memoryEntries.id, entryIds));
    }
    await db.$client.end({ timeout: 5 });
  });

  it('forgetInScopes deletes only within the caller scopes', async () => {
    const mineUserId = randomUUID();
    const myGroupId = randomUUID();
    const otherUserId = randomUUID();
    const otherGroupId = randomUUID();
    entryIds.push(mineUserId, myGroupId, otherUserId, otherGroupId);
    const senderOpenId = `ou_${randomUUID()}`;
    const chatScopeId = `tenant:${scopeId}`;

    await db.insert(memoryEntries).values([
      {
        id: mineUserId,
        scopeType: 'user',
        scopeId: senderOpenId,
        memoryType: 'fact',
        content: 'secret keyword in my user scope',
        confirmed: true,
        status: 'active',
      },
      {
        id: myGroupId,
        scopeType: 'group',
        scopeId: chatScopeId,
        memoryType: 'fact',
        content: 'secret keyword in my group scope',
        confirmed: true,
        status: 'active',
      },
      {
        id: otherUserId,
        scopeType: 'user',
        scopeId: `ou_${randomUUID()}`,
        memoryType: 'fact',
        content: 'secret keyword in another user scope',
        confirmed: true,
        status: 'active',
      },
      {
        id: otherGroupId,
        scopeType: 'group',
        scopeId: `tenant:${randomUUID()}`,
        memoryType: 'fact',
        content: 'secret keyword in another group scope',
        confirmed: true,
        status: 'active',
      },
    ]);

    const count = await handler.forgetInScopes('secret keyword', [
      { scopeType: 'user', scopeId: senderOpenId },
      { scopeType: 'group', scopeId: chatScopeId },
    ]);
    expect(count).toBe(2);

    const survivors = await db
      .select()
      .from(memoryEntries)
      .where(inArray(memoryEntries.id, [otherUserId, otherGroupId]));
    expect(survivors.every((s) => s.status === 'active')).toBe(true);
  });

  it('retrieves unexpired entries but filters expired ones', async () => {
    const liveId = randomUUID();
    const expiredId = randomUUID();
    const eternalId = randomUUID();
    entryIds.push(liveId, expiredId, eternalId);

    await db.insert(memoryEntries).values([
      {
        id: liveId,
        scopeType: 'group',
        scopeId,
        memoryType: 'fact',
        content: 'live entry',
        confirmed: true,
        status: 'active',
        ttlAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        id: expiredId,
        scopeType: 'group',
        scopeId,
        memoryType: 'fact',
        content: 'expired entry',
        confirmed: true,
        status: 'active',
        ttlAt: new Date(Date.now() - 60 * 1000),
      },
      {
        id: eternalId,
        scopeType: 'group',
        scopeId,
        memoryType: 'fact',
        content: 'eternal entry',
        confirmed: true,
        status: 'active',
        ttlAt: null,
      },
    ]);

    const results = await handler.retrieve({ scopeType: 'group', scopeId });
    const contents = results.map((r) => r.content);

    expect(contents).toContain('live entry');
    expect(contents).toContain('eternal entry');
    expect(contents).not.toContain('expired entry');
  });
});
