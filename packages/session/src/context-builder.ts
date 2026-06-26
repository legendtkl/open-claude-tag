import type { Database } from '@open-tag/storage';
import { sessions, messages, memoryEntries } from '@open-tag/storage';
import { eq, and, desc, asc, or } from 'drizzle-orm';
import { estimateTokens } from './token-estimator.js';

export interface ContextBudget {
  systemPromptRatio: number;
  memoryRatio: number;
  recentTurnsRatio: number;
  outputReserveRatio: number;
  totalBudget: number;
}

export const DEFAULT_BUDGET: ContextBudget = {
  systemPromptRatio: 0.15,
  memoryRatio: 0.2,
  recentTurnsRatio: 0.55,
  outputReserveRatio: 0.1,
  totalBudget: 128000, // ~128k tokens
};

export interface BuiltContext {
  systemPrompt: string;
  memorySection: string;
  recentTurns: Array<{ role: string; content: string; messageId?: string | null }>;
  recentImageAttachments: ContextImageAttachment[];
  totalTokens: number;
  budget: ContextBudget;
  compactTriggered: 'none' | 'soft' | 'hard';
}

export interface ContextImageAttachment {
  imageKey: string;
  messageId: string;
  sourceMessageId?: string | null;
  sourceRole: string;
  sourceContent: string;
}

/**
 * A compact verified gist from the shared context (DeLM C). Structurally
 * compatible with `SharedContextStore.list()` results, kept as a local type so
 * the session package does not need to depend on `@open-tag/memory`.
 */
export interface SharedContextGist {
  memoryType: string;
  gist: string;
  authorAgentKind?: string | null;
}

export interface BuildContextOptions {
  agentId?: string;
  budget?: ContextBudget;
  includeSessionHistory?: boolean;
  delegationContextPackage?: string;
  /**
   * Verified shared-context gists to inject (cross-kind / cross-machine handoff).
   * When omitted, context assembly is byte-for-byte identical to before.
   */
  sharedContextEntries?: SharedContextGist[];
}

/**
 * Render verified shared-context gists into a markdown section. Returns '' when
 * there are no entries, so callers that pass nothing get unchanged output.
 */
export function buildSharedContextSection(entries: SharedContextGist[] | undefined): string {
  if (!entries || entries.length === 0) return '';
  const lines = entries.map((e) => {
    const kind = e.authorAgentKind ? ` (${e.authorAgentKind})` : '';
    return `- [${e.memoryType}]${kind} ${e.gist}`;
  });
  return `## Shared Context (verified)\n${lines.join('\n')}\n\n`;
}

export interface CompactResult {
  tokensBefore: number;
  tokensAfter: number;
  messagesRemoved: number;
  summaryGenerated: boolean;
}

export interface VisibleMemoryScope {
  scopeType: 'session' | 'agent' | 'agent_session';
  scopeId: string;
}

interface AgentVisibleMessage {
  agentId?: string | null;
}

interface MessageWithImageMetadata {
  role: string;
  content: string;
  feishuMessageId?: string | null;
  metadata?: unknown;
}

export function agentSessionMemoryScopeId(agentId: string, sessionId: string): string {
  return `${agentId}:${sessionId}`;
}

export function buildVisibleMemoryScopes(
  sessionId: string,
  agentId?: string,
): VisibleMemoryScope[] {
  const scopes: VisibleMemoryScope[] = [{ scopeType: 'session', scopeId: sessionId }];
  if (agentId) {
    scopes.push(
      { scopeType: 'agent', scopeId: agentId },
      { scopeType: 'agent_session', scopeId: agentSessionMemoryScopeId(agentId, sessionId) },
    );
  }
  return scopes;
}

export function isMessageVisibleToAgent(
  message: AgentVisibleMessage,
  agentId?: string,
): boolean {
  void message;
  void agentId;
  return true;
}

export function filterMessagesVisibleToAgent<T extends AgentVisibleMessage>(
  inputMessages: T[],
  agentId?: string,
): T[] {
  return inputMessages.filter((message) => isMessageVisibleToAgent(message, agentId));
}

function isContextBudget(value: ContextBudget | BuildContextOptions): value is ContextBudget {
  return 'totalBudget' in value;
}

function normalizeContextOptions(
  optionsOrBudget: ContextBudget | BuildContextOptions,
): Required<Pick<BuildContextOptions, 'budget' | 'includeSessionHistory'>> &
  Omit<BuildContextOptions, 'budget' | 'includeSessionHistory'> {
  if (isContextBudget(optionsOrBudget)) {
    return { budget: optionsOrBudget, includeSessionHistory: true };
  }

  return {
    ...optionsOrBudget,
    budget: optionsOrBudget.budget ?? DEFAULT_BUDGET,
    includeSessionHistory: optionsOrBudget.includeSessionHistory ?? true,
  };
}

export async function buildContext(
  db: Database,
  sessionId: string,
  systemPrompt: string,
  optionsOrBudget: ContextBudget | BuildContextOptions = DEFAULT_BUDGET,
): Promise<BuiltContext> {
  const options = normalizeContextOptions(optionsOrBudget);
  const budget = options.budget;
  const systemTokens = Math.floor(budget.totalBudget * budget.systemPromptRatio);
  const memoryTokens = Math.floor(budget.totalBudget * budget.memoryRatio);
  const turnsTokens = Math.floor(budget.totalBudget * budget.recentTurnsRatio);

  // Get session summary
  const sessionRows = await db
    .select({ summary: sessions.summary })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const sessionSummary = sessionRows[0]?.summary ?? '';

  // Get memory entries visible to this task. Legacy calls only use session scope.
  const visibleMemoryScopes = buildVisibleMemoryScopes(sessionId, options.agentId);
  const visibleMemoryScopeConditions = visibleMemoryScopes.map((scope) =>
    and(eq(memoryEntries.scopeType, scope.scopeType), eq(memoryEntries.scopeId, scope.scopeId)),
  );
  const memEntries = await db
    .select()
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.status, 'active'),
        or(...visibleMemoryScopeConditions),
      ),
    )
    .orderBy(desc(memoryEntries.importanceScore))
    .limit(20);

  // Build memory section
  let memorySection = '';
  let memoryUsed = 0;
  if (options.delegationContextPackage) {
    const packageTokens = estimateTokens(options.delegationContextPackage);
    if (memoryUsed + packageTokens <= memoryTokens) {
      memorySection += `## Delegation Context\n${options.delegationContextPackage}\n\n`;
      memoryUsed += packageTokens;
    }
  }
  if (sessionSummary) {
    const summaryTokens = estimateTokens(sessionSummary);
    if (memoryUsed + summaryTokens <= memoryTokens) {
      memorySection += `## Session Summary\n${sessionSummary}\n\n`;
      memoryUsed += summaryTokens;
    }
  }
  const sharedContextSection = buildSharedContextSection(options.sharedContextEntries);
  if (sharedContextSection) {
    const sharedTokens = estimateTokens(sharedContextSection);
    if (memoryUsed + sharedTokens <= memoryTokens) {
      memorySection += sharedContextSection;
      memoryUsed += sharedTokens;
    }
  }
  for (const entry of memEntries) {
    const entryTokens = estimateTokens(entry.content);
    if (memoryUsed + entryTokens > memoryTokens) break;
    memorySection += `- [${entry.memoryType}] ${entry.content}\n`;
    memoryUsed += entryTokens;
  }

  // Get recent messages, newest first. Feishu topic/session history is visible
  // across agents so a second agent can evaluate or continue another agent's
  // visible reply. Agent-specific long-term memory remains scoped separately.
  const allMessages = options.includeSessionHistory
    ? await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(desc(messages.createdAt))
        .limit(100)
    : [];

  // Fill recent turns from newest to oldest within budget
  const recentTurns: Array<{ role: string; content: string; messageId?: string | null }> = [];
  const recentImageAttachments: ContextImageAttachment[] = [];
  let turnsUsed = 0;
  for (const msg of filterMessagesVisibleToAgent(allMessages, options.agentId)) {
    const tokenEst = msg.tokenEstimate ?? estimateTokens(msg.content);
    if (turnsUsed + tokenEst > turnsTokens) break;
    recentTurns.unshift({ role: msg.role, content: msg.content, messageId: msg.feishuMessageId });
    recentImageAttachments.unshift(...extractImageAttachmentsFromMessage(msg));
    turnsUsed += tokenEst;
  }

  // Truncate system prompt if needed
  const truncatedPrompt =
    estimateTokens(systemPrompt) > systemTokens
      ? systemPrompt.slice(0, systemTokens * 4) // rough truncation
      : systemPrompt;

  const totalTokens = estimateTokens(truncatedPrompt) + memoryUsed + turnsUsed;

  // Determine compact trigger
  let compactTriggered: 'none' | 'soft' | 'hard' = 'none';
  const usageRatio = totalTokens / budget.totalBudget;
  if (usageRatio >= 0.85) {
    compactTriggered = 'hard';
  } else if (usageRatio >= 0.7) {
    compactTriggered = 'soft';
  }

  return {
    systemPrompt: truncatedPrompt,
    memorySection,
    recentTurns,
    recentImageAttachments,
    totalTokens,
    budget,
    compactTriggered,
  };
}

function extractImageAttachmentsFromMessage(message: MessageWithImageMetadata): ContextImageAttachment[] {
  const metadata = isObjectRecord(message.metadata) ? message.metadata : undefined;
  const referencedMessages = Array.isArray(metadata?.referencedMessages)
    ? metadata.referencedMessages
    : [];
  const attachments: ContextImageAttachment[] = [];
  const directImageAttachment = isObjectRecord(metadata?.imageAttachment)
    ? metadata.imageAttachment
    : undefined;
  const directImageKey =
    typeof directImageAttachment?.imageKey === 'string' ? directImageAttachment.imageKey : '';
  const directMessageId =
    typeof directImageAttachment?.messageId === 'string'
      ? directImageAttachment.messageId
      : message.feishuMessageId ?? '';
  if (directImageKey && directMessageId) {
    attachments.push({
      imageKey: directImageKey,
      messageId: directMessageId,
      sourceMessageId: message.feishuMessageId,
      sourceRole: message.role,
      sourceContent: message.content,
    });
  }
  for (const referencedMessage of referencedMessages) {
    if (!isObjectRecord(referencedMessage)) continue;
    const imageAttachment = isObjectRecord(referencedMessage.imageAttachment)
      ? referencedMessage.imageAttachment
      : undefined;
    const imageKey = typeof imageAttachment?.imageKey === 'string' ? imageAttachment.imageKey : '';
    const messageId =
      typeof imageAttachment?.messageId === 'string'
        ? imageAttachment.messageId
        : typeof referencedMessage.messageId === 'string'
          ? referencedMessage.messageId
          : '';
    if (!imageKey || !messageId) continue;
    attachments.push({
      imageKey,
      messageId,
      sourceMessageId:
        typeof referencedMessage.messageId === 'string'
          ? referencedMessage.messageId
          : message.feishuMessageId,
      sourceRole: message.role,
      sourceContent: message.content,
    });
  }
  return dedupeImageAttachments(attachments);
}

function dedupeImageAttachments(attachments: ContextImageAttachment[]): ContextImageAttachment[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = `${attachment.messageId}:${attachment.imageKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function compactSession(db: Database, sessionId: string): Promise<CompactResult> {
  // Get all messages
  const allMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  const totalBefore = allMessages.reduce(
    (sum, m) => sum + (m.tokenEstimate ?? estimateTokens(m.content)),
    0,
  );

  if (allMessages.length <= 5) {
    return {
      tokensBefore: totalBefore,
      tokensAfter: totalBefore,
      messagesRemoved: 0,
      summaryGenerated: false,
    };
  }

  // Keep last 5 messages, summarize the rest
  const toSummarize = allMessages.slice(0, -5);
  const kept = allMessages.slice(-5);

  // Generate a simple extractive summary
  const summaryParts: string[] = [];
  for (const msg of toSummarize) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      const preview = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
      summaryParts.push(`[${msg.role}]: ${preview}`);
    }
  }
  const summary = summaryParts.join('\n');

  // Update session summary
  await db
    .update(sessions)
    .set({ summary, updatedAt: new Date() })
    .where(eq(sessions.id, sessionId));

  // Delete old messages (in production, we'd archive them)
  for (const msg of toSummarize) {
    await db.delete(messages).where(eq(messages.id, msg.id));
  }

  const tokensAfter = kept.reduce(
    (sum, m) => sum + (m.tokenEstimate ?? estimateTokens(m.content)),
    0,
  );

  return {
    tokensBefore: totalBefore,
    tokensAfter: tokensAfter + estimateTokens(summary),
    messagesRemoved: toSummarize.length,
    summaryGenerated: true,
  };
}
