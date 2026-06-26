import type { Database } from '@open-tag/storage';
import { auditEvents } from '@open-tag/storage';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import { AuditSeverity } from '@open-tag/core-types';

export interface AuditQuery {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  severity?: AuditSeverity;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  severity: string;
  detail: unknown;
  createdAt: Date;
}

export class AuditService {
  constructor(private readonly db: Database) {}

  async record(
    actorId: string | null,
    action: string,
    targetType?: string,
    targetId?: string,
    detail?: Record<string, unknown>,
    severity: AuditSeverity = AuditSeverity.INFO,
  ): Promise<void> {
    await this.db.insert(auditEvents).values({
      actorId,
      action,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      severity,
      detail: detail ?? {},
    });
  }

  async query(params: AuditQuery): Promise<AuditEntry[]> {
    const conditions = [];

    if (params.actorId) {
      conditions.push(eq(auditEvents.actorId, params.actorId));
    }
    if (params.action) {
      conditions.push(eq(auditEvents.action, params.action));
    }
    if (params.targetType) {
      conditions.push(eq(auditEvents.targetType, params.targetType));
    }
    if (params.targetId) {
      conditions.push(eq(auditEvents.targetId, params.targetId));
    }
    if (params.severity) {
      conditions.push(eq(auditEvents.severity, params.severity));
    }
    if (params.from) {
      conditions.push(gte(auditEvents.createdAt, params.from));
    }
    if (params.to) {
      conditions.push(lte(auditEvents.createdAt, params.to));
    }

    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const query = this.db
      .select()
      .from(auditEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit)
      .offset(offset);

    return query as unknown as AuditEntry[];
  }
}
