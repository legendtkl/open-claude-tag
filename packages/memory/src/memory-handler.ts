import type { Database } from '@open-tag/storage';
import { memoryEntries } from '@open-tag/storage';
import { eq, and, desc, gt, isNull, like, or } from 'drizzle-orm';
import { containsSensitiveInfo } from './sensitive-filter.js';

export type MemoryScopeType =
  | 'session'
  | 'user'
  | 'group'
  | 'system'
  | 'agent'
  | 'agent_session';

export interface MemoryWriteRequest {
  scopeType: MemoryScopeType;
  scopeId: string;
  memoryType: 'summary' | 'fact' | 'preference' | 'instruction' | 'decision';
  content: string;
  tags?: string[];
  importanceScore?: number;
  confidence?: number;
  sourceMessageId?: string;
}

export interface MemoryQuery {
  scopeType?: 'session' | 'user' | 'group' | 'system' | 'agent' | 'agent_session';
  scopeId?: string;
  memoryType?: string;
  keyword?: string;
  includeUnconfirmed?: boolean;
  limit?: number;
}

export interface MemoryEntry {
  id: string;
  scopeType: string;
  scopeId: string;
  memoryType: string;
  content: string;
  tags: string[];
  importanceScore: number;
  confidence: number;
  confirmed: boolean;
  status: string;
  createdAt: Date;
}

export class MemoryHandler {
  constructor(private readonly db: Database) {}

  async write(request: MemoryWriteRequest): Promise<{ id: string } | { error: string }> {
    // Security: filter sensitive content
    if (containsSensitiveInfo(request.content)) {
      return {
        error:
          'Content contains sensitive information (API keys, tokens, passwords). Memory entry rejected.',
      };
    }

    const confidence = request.confidence ?? 1.0;

    // Low confidence: discard
    if (confidence < 0.5) {
      return { error: 'Confidence too low, memory entry discarded' };
    }

    const confirmed = confidence >= 0.8;

    const [entry] = await this.db
      .insert(memoryEntries)
      .values({
        scopeType: request.scopeType,
        scopeId: request.scopeId,
        memoryType: request.memoryType,
        content: request.content,
        tags: request.tags ?? [],
        importanceScore: request.importanceScore ?? 0.5,
        confidence,
        confirmed,
        sourceMessageId: request.sourceMessageId,
        status: 'active',
      })
      .returning({ id: memoryEntries.id });

    return { id: entry.id };
  }

  async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    const conditions = [
      eq(memoryEntries.status, 'active'),
      // ttl_at was a dead column: expired entries were retrieved forever.
      or(isNull(memoryEntries.ttlAt), gt(memoryEntries.ttlAt, new Date()))!,
    ];

    if (query.scopeType) {
      conditions.push(eq(memoryEntries.scopeType, query.scopeType));
    }
    if (query.scopeId) {
      conditions.push(eq(memoryEntries.scopeId, query.scopeId));
    }
    if (query.memoryType) {
      conditions.push(eq(memoryEntries.memoryType, query.memoryType));
    }
    if (!query.includeUnconfirmed) {
      conditions.push(eq(memoryEntries.confirmed, true));
    }
    if (query.keyword) {
      conditions.push(like(memoryEntries.content, `%${query.keyword}%`));
    }

    const rows = await this.db
      .select()
      .from(memoryEntries)
      .where(and(...conditions))
      .orderBy(desc(memoryEntries.importanceScore), desc(memoryEntries.createdAt))
      .limit(query.limit ?? 20);

    return rows.map((r) => ({
      id: r.id,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      memoryType: r.memoryType,
      content: r.content,
      tags: (r.tags as string[]) ?? [],
      importanceScore: r.importanceScore,
      confidence: r.confidence,
      confirmed: r.confirmed,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  async forget(keyword: string, scopeType?: string, scopeId?: string): Promise<number> {
    const conditions = [
      eq(memoryEntries.status, 'active'),
      like(memoryEntries.content, `%${keyword}%`),
    ];

    if (scopeType) conditions.push(eq(memoryEntries.scopeType, scopeType));
    if (scopeId) conditions.push(eq(memoryEntries.scopeId, scopeId));

    const deleted = await this.db
      .update(memoryEntries)
      .set({ status: 'deleted', updatedAt: new Date() })
      .where(and(...conditions))
      .returning();

    return deleted.length;
  }

  /**
   * Forget matching entries, restricted to the given scopes. Unscoped
   * `forget` deletes across every scope (including other users' and other
   * chats' memories); the `/forget` command must pass the caller's scopes so
   * one user cannot wipe another's memory.
   */
  async forgetInScopes(
    keyword: string,
    scopes: Array<{ scopeType: MemoryScopeType; scopeId: string }>,
  ): Promise<number> {
    if (scopes.length === 0) return 0;

    const scopeMatch = scopes.map((s) =>
      and(eq(memoryEntries.scopeType, s.scopeType), eq(memoryEntries.scopeId, s.scopeId)),
    );

    const deleted = await this.db
      .update(memoryEntries)
      .set({ status: 'deleted', updatedAt: new Date() })
      .where(
        and(
          eq(memoryEntries.status, 'active'),
          like(memoryEntries.content, `%${keyword}%`),
          or(...scopeMatch)!,
        ),
      )
      .returning();

    return deleted.length;
  }

  async compact(scopeType: string, scopeId: string): Promise<number> {
    // Get all summary-type entries for this scope
    const summaries = await this.db
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.scopeType, scopeType),
          eq(memoryEntries.scopeId, scopeId),
          eq(memoryEntries.memoryType, 'summary'),
          eq(memoryEntries.status, 'active'),
        ),
      )
      .orderBy(memoryEntries.createdAt);

    if (summaries.length <= 1) return 0;

    // Merge all summaries into one
    const mergedContent = summaries.map((s) => s.content).join('\n---\n');

    // Archive old summaries
    for (const s of summaries) {
      await this.db
        .update(memoryEntries)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(memoryEntries.id, s.id));
    }

    // Create merged summary
    await this.db.insert(memoryEntries).values({
      scopeType,
      scopeId,
      memoryType: 'summary',
      content: mergedContent,
      importanceScore: 0.8,
      confidence: 1.0,
      confirmed: true,
      status: 'active',
    });

    return summaries.length;
  }
}
