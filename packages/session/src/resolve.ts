import type { InboundMessage } from '@open-tag/channel-core';
import type { NormalizedEvent } from '@open-tag/core-types';
import type { Database } from '@open-tag/storage';
import {
  sessions,
  sessionAliases,
  chatActiveSessions,
  chatConfigs,
  messages,
  tasks,
  admissionLeases,
  waitingContracts,
  sharedContextEntries,
  agentSessionStates,
  discussions,
  discussionParticipants,
  discussionTurns,
  memoryEntries,
  agentDelegations,
} from '@open-tag/storage';
import { and, eq, like, or } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { isAbsolute } from 'node:path';

function readDefaultWorkDirEnv(): string | null {
  const raw = process.env.OPEN_TAG_DEFAULT_WORKDIR?.trim();
  if (!raw) return null;
  // Only absolute paths are accepted; relative paths would be ambiguous across
  // API and worker processes that may run from different cwds.
  if (!isAbsolute(raw)) return null;
  return raw;
}

export interface ResolveResult {
  sessionId: string;
  sessionKey: string;
  isNew: boolean;
  scope: string;
}

interface SessionDefaults {
  defaultWorkDir: string | null;
}

interface ExistingSessionRow {
  id: string;
  sessionKey: string;
  scope: string;
  adhocWorkDir?: string | null;
  worktreePath?: string | null;
  projectId?: string | null;
}

/**
 * The primitive inputs the session-key derivation needs, projected off the neutral
 * {@link InboundMessage}. Neutral scope/conversation/content/sender drive every key
 * shape; only the byte-identity-critical bits that are non-lossless on the typed
 * surface dip into the lark `channel.native` (see {@link extractSessionKeyInputs}).
 */
interface SessionKeyInputs {
  /** Key namespace. `lark` keeps the historical `feishu` value so persisted keys stay byte-identical. */
  namespace: string;
  tenant: string;
  chatId: string;
  isPrivate: boolean;
  isGroup: boolean;
  messageId: string;
  threadId?: string;
  rootMessageId?: string;
  parentMessageId?: string;
  contentType: string;
  command?: string;
  args?: string;
  senderId: string;
  /**
   * Message ids of quoted IMAGE messages. Used to keep a quoted-image topic-start
   * from binding to the referenced image's id. This is the only key input that is
   * non-lossless on the neutral surface (the adapter drops a referenced message's
   * imageAttachment), so it dips into the lark `channel.native`; a non-lark channel
   * has no such concept and contributes an empty set.
   */
  referencedImageMessageIds: Set<string>;
}

/**
 * Session-key namespace for a channel. Lark MUST stay `feishu` so persisted
 * `sessions.sessionKey` strings remain byte-identical; a future channel derives its
 * namespace from its kind and keys purely off the neutral scope/conversation.
 */
function sessionKeyNamespace(message: InboundMessage): string {
  return message.channel.kind === 'lark' ? 'feishu' : message.channel.kind;
}

/** Quoted-image message ids from a lark native event; empty for any non-lark channel. */
function larkReferencedImageMessageIds(native: NormalizedEvent | undefined): Set<string> {
  if (!native) return new Set<string>();
  return new Set(
    native.content.referencedMessages
      ?.filter((message) => message.imageAttachment)
      .flatMap((message) =>
        [message.messageId, message.imageAttachment?.messageId].filter(
          (value): value is string => Boolean(value),
        ),
      ) ?? [],
  );
}

/**
 * Project the neutral {@link InboundMessage} onto the primitive session-key inputs.
 * Neutral scope/conversation/content/sender drive every key shape; only the two
 * byte-identity-critical bits that are non-lossless on the typed surface — the exact
 * lark message id and the quoted-image ids — dip into the lark `channel.native`,
 * guarded by `kind === 'lark'` (mirroring `recoverFeishuNormalizedEvent`).
 */
function extractSessionKeyInputs(message: InboundMessage): SessionKeyInputs {
  const larkNative =
    message.channel.kind === 'lark' ? (message.channel.native as NormalizedEvent) : undefined;
  return {
    namespace: sessionKeyNamespace(message),
    tenant: message.scope.installationId,
    chatId: message.scope.scopeId,
    isPrivate: message.scope.isPrivate,
    isGroup: !message.scope.isPrivate,
    // Lark: the native message id is byte-authoritative. The neutral surface
    // replaces an empty id with eventId, which would shift the bootstrap key.
    messageId: larkNative?.messageId ?? message.messageId,
    threadId: message.conversation.threadId,
    rootMessageId: message.conversation.reply?.rootId,
    parentMessageId: message.conversation.reply?.parentId,
    contentType: message.content.type,
    command: message.content.command,
    args: message.content.args,
    senderId: message.sender.id,
    referencedImageMessageIds: larkReferencedImageMessageIds(larkNative),
  };
}

export async function resolveSession(
  db: Database,
  message: InboundMessage,
): Promise<ResolveResult> {
  const inputs = extractSessionKeyInputs(message);
  const { namespace: ns, tenant, chatId } = inputs;
  const sessionDefaults = await readSessionDefaults(db, tenant, chatId);
  const parentOnlyThreadId =
    !inputs.threadId && !inputs.rootMessageId ? inputs.parentMessageId : undefined;
  const candidateThreadIds = uniqueValues([
    normalizeThreadSessionCandidate(inputs, inputs.threadId),
    normalizeThreadSessionCandidate(inputs, inputs.rootMessageId),
  ]);
  const candidateThreadIdsWithParent = uniqueValues([
    normalizeThreadSessionCandidate(inputs, inputs.threadId),
    normalizeThreadSessionCandidate(inputs, inputs.rootMessageId),
    normalizeThreadSessionCandidate(inputs, inputs.parentMessageId),
  ]);

  // Rule 1: P2P — root messages bootstrap a topic-scoped session;
  // follow-up topic messages resolve through the thread/alias path.
  if (inputs.isPrivate) {
    if (candidateThreadIdsWithParent.length > 0) {
      return resolveThreadSessionCandidates(
        db,
        ns,
        tenant,
        chatId,
        candidateThreadIdsWithParent,
        sessionDefaults,
      );
    }

    const provisionalKey = `${ns}:${tenant}:${chatId}:bootstrap:${inputs.messageId}`;
    return getOrCreateSession(db, provisionalKey, chatId, 'thread', sessionDefaults, inputs.senderId);
  }

  // Rule 2: Slash commands
  if (inputs.contentType === 'command') {
    const cmd = inputs.command;
    const isHelpRequest = inputs.args?.trim() === '--help';

    if (cmd === '/new' && !isHelpRequest) {
      return createManualSession(db, ns, tenant, chatId);
    }

    if (cmd === '/reset' && !isHelpRequest) {
      // Reset active pointer to group:main
      const mainKey = `${ns}:${tenant}:${chatId}:group:main`;
      await db
        .delete(chatActiveSessions)
        .where(
          and(eq(chatActiveSessions.tenantKey, tenant), eq(chatActiveSessions.chatId, chatId)),
        );
      return getOrCreateSession(db, mainKey, chatId, 'group-main', sessionDefaults);
    }
  }

  // Rule 3: Thread — messages within a thread share session.
  // Group follow-ups inside a topic carry `thread_id` or `root_id` when Feishu
  // exposes the established topic. Some follow-ups may only carry `parent_id`;
  // try that as an alias, but do not create a brand-new session keyed to the
  // parent. A parent-only root message is usually a quoted source message (for
  // example replying to an image to start a new OpenClaudeTag topic), so it should
  // bootstrap from the current message id instead of binding the session to the
  // quoted source.
  if (candidateThreadIds.length > 0) {
    return resolveThreadSessionCandidates(db, ns, tenant, chatId, candidateThreadIds, sessionDefaults);
  }
  if (parentOnlyThreadId) {
    const existing = await findThreadSession(db, ns, tenant, chatId, parentOnlyThreadId, sessionDefaults);
    if (existing) return existing;
  }

  // Rule 4: Check active manual session
  const activeManual = await db
    .select()
    .from(chatActiveSessions)
    .where(and(eq(chatActiveSessions.tenantKey, tenant), eq(chatActiveSessions.chatId, chatId)))
    .limit(1);

  if (activeManual.length > 0) {
    const active = activeManual[0];
    // Check if expired
    if (!active.expiresAt || active.expiresAt > new Date()) {
      if (active.activeSessionId) {
        const session = await db
          .select()
          .from(sessions)
          .where(eq(sessions.id, active.activeSessionId))
          .limit(1);
        if (session.length > 0 && session[0].status === 'active') {
          return resolveExistingSession(db, session[0], sessionDefaults);
        }
      }
    } else {
      // Expired — remove pointer, fall through to group:main
      await db
        .delete(chatActiveSessions)
        .where(
          and(eq(chatActiveSessions.tenantKey, tenant), eq(chatActiveSessions.chatId, chatId)),
        );
    }
  }

  // Rule 5: Group main (default) or provisional
  // True root messages (no thread/root/parent context) bootstrap a provisional
  // session so the alias-upgrade path can later attach the new topic to it.
  if (candidateThreadIds.length === 0 && inputs.isGroup) {
    const provisionalKey = `${ns}:${tenant}:${chatId}:bootstrap:${inputs.messageId}`;
    return getOrCreateSession(db, provisionalKey, chatId, 'thread', sessionDefaults);
  }

  // Fallback: group main
  const mainKey = `${ns}:${tenant}:${chatId}:group:main`;
  return getOrCreateSession(db, mainKey, chatId, 'group-main', sessionDefaults);
}

async function createManualSession(
  db: Database,
  ns: string,
  tenant: string,
  chatId: string,
): Promise<ResolveResult> {
  const uuid = randomUUID();
  const key = `${ns}:${tenant}:${chatId}:manual:${uuid}`;
  const sessionDefaults = await readSessionDefaults(db, tenant, chatId);

  const result = await getOrCreateSession(db, key, chatId, 'group-manual', sessionDefaults);

  // Update active session pointer
  await db
    .insert(chatActiveSessions)
    .values({
      tenantKey: tenant,
      chatId,
      activeSessionId: result.sessionId,
      createdBy: undefined,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h expiry
    })
    .onConflictDoUpdate({
      target: [chatActiveSessions.tenantKey, chatActiveSessions.chatId],
      set: {
        activeSessionId: result.sessionId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
    });

  return result;
}

async function resolveThreadSessionCandidates(
  db: Database,
  ns: string,
  tenant: string,
  chatId: string,
  threadIds: string[],
  sessionDefaults: SessionDefaults,
): Promise<ResolveResult> {
  for (const threadId of threadIds) {
    const existing = await findThreadSession(db, ns, tenant, chatId, threadId, sessionDefaults);
    if (existing) return existing;
  }

  return getOrCreateSession(
    db,
    `${ns}:${tenant}:${chatId}:thread:${threadIds[0]}`,
    chatId,
    'thread',
    sessionDefaults,
  );
}

async function findThreadSession(
  db: Database,
  ns: string,
  tenant: string,
  chatId: string,
  threadId: string,
  defaults: SessionDefaults,
): Promise<ResolveResult | null> {
  const key = `${ns}:${tenant}:${chatId}:thread:${threadId}`;
  const alias = await db
    .select()
    .from(sessionAliases)
    .where(eq(sessionAliases.aliasKey, key))
    .limit(1);
  if (alias.length > 0) {
    const session = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, alias[0].targetSessionId))
      .limit(1);
    if (session.length > 0) {
      return resolveExistingSession(db, session[0], defaults);
    }
  }

  const existing = await db.select().from(sessions).where(eq(sessions.sessionKey, key)).limit(1);
  if (existing.length > 0) {
    return resolveExistingSession(db, existing[0], defaults);
  }

  return null;
}

async function resolveExistingSession(
  db: Database,
  session: ExistingSessionRow,
  defaults: SessionDefaults,
): Promise<ResolveResult> {
  const defaultWorkDir = defaults.defaultWorkDir ?? readDefaultWorkDirEnv();
  if (
    defaultWorkDir &&
    !session.adhocWorkDir &&
    !session.worktreePath &&
    !session.projectId
  ) {
    await db
      .update(sessions)
      .set({ adhocWorkDir: defaultWorkDir, updatedAt: new Date() })
      .where(eq(sessions.id, session.id));
  }

  return {
    sessionId: session.id,
    sessionKey: session.sessionKey,
    isNew: false,
    scope: session.scope,
  };
}

// NOTE: `aliasThreadKeysForSession` / `upgradeProvisionalSession` build thread
// keys with the literal `feishu` namespace, matching `resolveSession`'s lark keys
// (where the namespace resolves to `feishu`). They are called only for the lark
// path today; a future non-lark channel that needs alias/upgrade would thread a
// namespace through here the same way `resolveSession` does.
export async function aliasThreadKeysForSession(
  db: Database,
  sessionId: string,
  threadIds: string | string[],
  tenant: string,
  chatId: string,
): Promise<void> {
  await withSessionMergeTransaction(db, async (tx) => {
    for (const threadId of uniqueValues(Array.isArray(threadIds) ? threadIds : [threadIds])) {
      const threadKey = `feishu:${tenant}:${chatId}:thread:${threadId}`;
      const [existingAlias] = await tx
        .select()
        .from(sessionAliases)
        .where(eq(sessionAliases.aliasKey, threadKey))
        .limit(1);
      if (existingAlias && existingAlias.targetSessionId !== sessionId) {
        await mergeSessionIntoTarget(tx, existingAlias.targetSessionId, sessionId);
      }

      const [existingThreadSession] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.sessionKey, threadKey))
        .limit(1);
      if (existingThreadSession && existingThreadSession.id !== sessionId) {
        await mergeSessionIntoTarget(tx, existingThreadSession.id, sessionId);
      }

      await tx
        .insert(sessionAliases)
        .values({
          aliasKey: threadKey,
          targetSessionId: sessionId,
        })
        .onConflictDoUpdate({
          target: sessionAliases.aliasKey,
          set: { targetSessionId: sessionId },
        });
    }
  });
}

export async function canonicalizeSessionId(db: Database, sessionId: string): Promise<string> {
  return withSessionMergeTransaction(db, async (tx) => {
    const [session] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return sessionId;

    const [alias] = await tx
      .select()
      .from(sessionAliases)
      .where(eq(sessionAliases.aliasKey, session.sessionKey))
      .limit(1);
    if (!alias || alias.targetSessionId === sessionId) return sessionId;

    await mergeSessionIntoTarget(tx, sessionId, alias.targetSessionId);
    return alias.targetSessionId;
  });
}

async function withSessionMergeTransaction<T>(
  db: Database,
  callback: (tx: Database) => Promise<T>,
): Promise<T> {
  const transactional = db as Database & {
    transaction?: (callback: (tx: Database) => Promise<T>) => Promise<T>;
  };
  if (typeof transactional.transaction === 'function') {
    return transactional.transaction(callback);
  }
  return callback(db);
}

async function mergeSessionIntoTarget(
  db: Database,
  sourceSessionId: string,
  targetSessionId: string,
): Promise<void> {
  if (sourceSessionId === targetSessionId) return;

  await mergeAgentSessionStates(db, sourceSessionId, targetSessionId);
  await mergeDiscussionSession(db, sourceSessionId, targetSessionId);
  await mergeMemoryScopes(db, sourceSessionId, targetSessionId);
  await db
    .update(agentDelegations)
    .set({ childSessionId: targetSessionId, updatedAt: new Date() })
    .where(eq(agentDelegations.childSessionId, sourceSessionId));
  await db.update(messages).set({ sessionId: targetSessionId }).where(eq(messages.sessionId, sourceSessionId));
  await db.update(tasks).set({ sessionId: targetSessionId }).where(eq(tasks.sessionId, sourceSessionId));
  await db
    .update(admissionLeases)
    .set({ sessionId: targetSessionId })
    .where(eq(admissionLeases.sessionId, sourceSessionId));
  await db
    .update(waitingContracts)
    .set({ sessionId: targetSessionId })
    .where(eq(waitingContracts.sessionId, sourceSessionId));
  await db
    .update(sharedContextEntries)
    .set({ sessionId: targetSessionId })
    .where(eq(sharedContextEntries.sessionId, sourceSessionId));
  await db
    .update(sharedContextEntries)
    .set({ scopeId: targetSessionId })
    .where(
      and(
        eq(sharedContextEntries.scopeType, 'session'),
        eq(sharedContextEntries.scopeId, sourceSessionId),
      ),
    );
  await db
    .update(sessionAliases)
    .set({ targetSessionId })
    .where(eq(sessionAliases.targetSessionId, sourceSessionId));
  await db
    .update(chatActiveSessions)
    .set({ activeSessionId: targetSessionId, updatedAt: new Date() })
    .where(eq(chatActiveSessions.activeSessionId, sourceSessionId));
  await db
    .update(sessions)
    .set({ status: 'merged', updatedAt: new Date() })
    .where(eq(sessions.id, sourceSessionId));
}

async function mergeMemoryScopes(
  db: Database,
  sourceSessionId: string,
  targetSessionId: string,
): Promise<void> {
  await db
    .update(memoryEntries)
    .set({ scopeId: targetSessionId, updatedAt: new Date() })
    .where(
      and(
        eq(memoryEntries.scopeType, 'session'),
        eq(memoryEntries.scopeId, sourceSessionId),
      ),
    );

  const agentSessionEntries = await db
    .select()
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.scopeType, 'agent_session'),
        or(
          eq(memoryEntries.scopeId, sourceSessionId),
          like(memoryEntries.scopeId, `%:${sourceSessionId}`),
        ),
      ),
    );
  for (const entry of agentSessionEntries) {
    if (typeof entry.scopeId !== 'string') continue;
    const nextScopeId = remapAgentSessionMemoryScope(
      entry.scopeId,
      sourceSessionId,
      targetSessionId,
    );
    if (!nextScopeId || nextScopeId === entry.scopeId) continue;
    await db
      .update(memoryEntries)
      .set({ scopeId: nextScopeId, updatedAt: new Date() })
      .where(eq(memoryEntries.id, entry.id));
  }
}

function remapAgentSessionMemoryScope(
  scopeId: string,
  sourceSessionId: string,
  targetSessionId: string,
): string | null {
  if (scopeId === sourceSessionId) return targetSessionId;
  const suffix = `:${sourceSessionId}`;
  if (!scopeId.endsWith(suffix)) return null;
  return `${scopeId.slice(0, -suffix.length)}:${targetSessionId}`;
}

async function mergeDiscussionSession(
  db: Database,
  sourceSessionId: string,
  targetSessionId: string,
): Promise<void> {
  const [sourceDiscussion] = await db
    .select()
    .from(discussions)
    .where(eq(discussions.sessionId, sourceSessionId))
    .limit(1);
  if (!sourceDiscussion) return;

  const [targetDiscussion] = await db
    .select()
    .from(discussions)
    .where(eq(discussions.sessionId, targetSessionId))
    .limit(1);
  if (targetDiscussion) {
    const mergeResult = await mergeDiscussionChildren(db, sourceDiscussion.id, targetDiscussion.id);
    await remapDiscussionTaskConstraints(db, sourceSessionId, sourceDiscussion.id, targetDiscussion.id);
    await remapDiscussionAdmissionLeaseConstraints(
      db,
      sourceSessionId,
      sourceDiscussion.id,
      targetDiscussion.id,
    );
    await db
      .update(discussions)
      .set(
        mergeDiscussionRowMetadata(
          sourceDiscussion,
          targetDiscussion,
          mergeResult.participantCount,
        ),
      )
      .where(eq(discussions.id, targetDiscussion.id));
    await db
      .update(discussions)
      .set({ status: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(discussions.id, sourceDiscussion.id));
    return;
  }

  await db
    .update(discussions)
    .set({ sessionId: targetSessionId, updatedAt: new Date() })
    .where(eq(discussions.id, sourceDiscussion.id));
}

type DiscussionRow = typeof discussions.$inferSelect;
type DiscussionParticipantRow = typeof discussionParticipants.$inferSelect;
type DiscussionTurnRow = typeof discussionTurns.$inferSelect;
type DiscussionTurnPosition = { round: number; turnIndex: number };

function mergeDiscussionRowMetadata(
  sourceDiscussion: DiscussionRow,
  targetDiscussion: DiscussionRow,
  participantCount: number,
): Partial<typeof discussions.$inferInsert> {
  const sourceActive = sourceDiscussion.status === 'active';
  const targetActive = targetDiscussion.status === 'active';
  const targetRoundLimit = numberOrDefault(targetDiscussion.roundLimit, 3);
  const sourceRoundLimit = numberOrDefault(sourceDiscussion.roundLimit, targetRoundLimit);
  const targetCursor = normalizeDiscussionPosition(
    {
      round: numberOrDefault(targetDiscussion.currentRound, 1),
      turnIndex: numberOrDefault(targetDiscussion.currentTurnIndex, 0),
    },
    participantCount,
  );
  const sourceOriginalCursor = normalizeDiscussionPosition(
    {
      round: numberOrDefault(sourceDiscussion.currentRound, targetCursor.round),
      turnIndex: numberOrDefault(sourceDiscussion.currentTurnIndex, targetCursor.turnIndex),
    },
    participantCount,
  );
  const sourceCursor = sourceOriginalCursor;
  const mergedCursor =
    compareDiscussionPositions(sourceCursor, targetCursor) > 0 ? sourceCursor : targetCursor;
  return {
    status: sourceActive || targetActive ? 'active' : targetDiscussion.status,
    roundLimit: Math.max(targetRoundLimit, sourceRoundLimit),
    currentRound: mergedCursor.round,
    currentTurnIndex: mergedCursor.turnIndex,
    completedAt: sourceActive || targetActive ? null : targetDiscussion.completedAt,
    updatedAt: new Date(),
  };
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function mergeDiscussionChildren(
  db: Database,
  sourceDiscussionId: string,
  targetDiscussionId: string,
): Promise<{ participantCount: number }> {
  const [sourceParticipants, targetParticipants, sourceTurns, targetTurns] = await Promise.all([
    db
      .select()
      .from(discussionParticipants)
      .where(eq(discussionParticipants.discussionId, sourceDiscussionId))
      .limit(1000),
    db
      .select()
      .from(discussionParticipants)
      .where(eq(discussionParticipants.discussionId, targetDiscussionId))
      .limit(1000),
    db
      .select()
      .from(discussionTurns)
      .where(eq(discussionTurns.discussionId, sourceDiscussionId))
      .limit(1000),
    db
      .select()
      .from(discussionTurns)
      .where(eq(discussionTurns.discussionId, targetDiscussionId))
      .limit(1000),
  ]);

  const participantMerge = await mergeDiscussionParticipants(
    db,
    sourceParticipants,
    targetParticipants,
    targetDiscussionId,
  );
  await moveDiscussionTurns(
    db,
    sourceTurns,
    targetTurns,
    targetDiscussionId,
    participantMerge.participantIdMap,
    participantMerge.participantCount,
  );
  return { participantCount: participantMerge.participantCount };
}

async function mergeDiscussionParticipants(
  db: Database,
  sourceParticipants: DiscussionParticipantRow[],
  targetParticipants: DiscussionParticipantRow[],
  targetDiscussionId: string,
): Promise<{ participantIdMap: Map<string, string | null>; participantCount: number }> {
  const participantIdMap = new Map<string, string | null>();
  const targetByAgent = new Map(
    targetParticipants.map((participant) => [participant.agentId, participant]),
  );
  const usedOrderIndexes = new Set(targetParticipants.map((participant) => participant.orderIndex));
  let nextOrderIndex =
    targetParticipants.reduce((max, participant) => Math.max(max, participant.orderIndex), -1) + 1;

  for (const participant of [...sourceParticipants].sort(compareDiscussionParticipants)) {
    const existing = targetByAgent.get(participant.agentId);
    if (existing) {
      participantIdMap.set(participant.id, existing.id);
      continue;
    }

    const orderIndex = nextOrderIndex++;
    usedOrderIndexes.add(orderIndex);
    participantIdMap.set(participant.id, participant.id);
    await db
      .update(discussionParticipants)
      .set({ discussionId: targetDiscussionId, orderIndex })
      .where(eq(discussionParticipants.id, participant.id));
  }

  return {
    participantIdMap,
    participantCount: Math.max(nextOrderIndex, usedOrderIndexes.size),
  };
}

function compareDiscussionParticipants(
  left: DiscussionParticipantRow,
  right: DiscussionParticipantRow,
): number {
  if (left.orderIndex !== right.orderIndex) return left.orderIndex - right.orderIndex;
  return left.id.localeCompare(right.id);
}

async function moveDiscussionTurns(
  db: Database,
  sourceTurns: DiscussionTurnRow[],
  targetTurns: DiscussionTurnRow[],
  targetDiscussionId: string,
  participantIdMap: Map<string, string | null>,
  participantCount: number,
): Promise<void> {
  const usedPositions = new Set(targetTurns.map((turn) => discussionTurnPositionKey(turn)));
  let appendPosition = normalizeDiscussionPosition(
    nextDiscussionTurnPosition(targetTurns),
    participantCount,
  );
  const orderedSourceTurns = [...sourceTurns].sort(compareDiscussionTurns);

  for (const turn of orderedSourceTurns) {
    let round = turn.round;
    let turnIndex = turn.turnIndex;
    const originalPosition = discussionTurnPositionKey(turn);
    if (usedPositions.has(originalPosition)) {
      ({ round, turnIndex } = appendPosition);
      appendPosition = advanceDiscussionPosition(appendPosition, participantCount);
    }
    usedPositions.add(`${round}:${turnIndex}`);

    const participantId =
      turn.participantId && participantIdMap.has(turn.participantId)
        ? participantIdMap.get(turn.participantId)
        : turn.participantId;

    await db
      .update(discussionTurns)
      .set({ discussionId: targetDiscussionId, participantId, round, turnIndex })
      .where(eq(discussionTurns.id, turn.id));
  }
}

function discussionTurnPositionKey(turn: DiscussionTurnPosition): string {
  return `${turn.round}:${turn.turnIndex}`;
}

function compareDiscussionTurns(left: DiscussionTurnRow, right: DiscussionTurnRow): number {
  const positionComparison = compareDiscussionPositions(left, right);
  if (positionComparison !== 0) return positionComparison;
  return left.createdAt.getTime() - right.createdAt.getTime();
}

function compareDiscussionPositions(
  left: DiscussionTurnPosition,
  right: DiscussionTurnPosition,
): number {
  if (left.round !== right.round) return left.round - right.round;
  return left.turnIndex - right.turnIndex;
}

function nextDiscussionTurnPosition(turns: DiscussionTurnRow[]): DiscussionTurnPosition {
  if (turns.length === 0) return { round: 1, turnIndex: 0 };
  const latest = [...turns].sort(compareDiscussionTurns).at(-1)!;
  return { round: latest.round, turnIndex: latest.turnIndex + 1 };
}

function advanceDiscussionPosition(
  position: DiscussionTurnPosition,
  participantCount: number,
): DiscussionTurnPosition {
  if (participantCount <= 0) {
    return { round: position.round, turnIndex: position.turnIndex + 1 };
  }
  const nextTurnIndex = position.turnIndex + 1;
  if (nextTurnIndex >= participantCount) {
    return { round: position.round + 1, turnIndex: 0 };
  }
  return { round: position.round, turnIndex: nextTurnIndex };
}

function normalizeDiscussionPosition(
  position: DiscussionTurnPosition,
  participantCount: number,
): DiscussionTurnPosition {
  if (participantCount <= 0 || position.turnIndex < participantCount) return position;
  return {
    round: position.round + Math.floor(position.turnIndex / participantCount),
    turnIndex: position.turnIndex % participantCount,
  };
}

async function remapDiscussionTaskConstraints(
  db: Database,
  sourceSessionId: string,
  sourceDiscussionId: string,
  targetDiscussionId: string,
): Promise<void> {
  const sourceTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.sessionId, sourceSessionId))
    .limit(1000);
  for (const task of sourceTasks) {
    const constraints = remapDiscussionIdInRecord(
      task.constraints,
      sourceDiscussionId,
      targetDiscussionId,
    );
    if (!constraints) continue;
    await db.update(tasks).set({ constraints }).where(eq(tasks.id, task.id));
  }
}

async function remapDiscussionAdmissionLeaseConstraints(
  db: Database,
  sourceSessionId: string,
  sourceDiscussionId: string,
  targetDiscussionId: string,
): Promise<void> {
  const leases = await db
    .select()
    .from(admissionLeases)
    .where(eq(admissionLeases.sessionId, sourceSessionId))
    .limit(1000);
  for (const lease of leases) {
    const jobData = isObjectRecord(lease.jobData) ? { ...lease.jobData } : undefined;
    if (!jobData) continue;
    const constraints = remapDiscussionIdInRecord(
      jobData.constraints,
      sourceDiscussionId,
      targetDiscussionId,
    );
    if (!constraints) continue;
    jobData.constraints = constraints;
    await db.update(admissionLeases).set({ jobData }).where(eq(admissionLeases.taskId, lease.taskId));
  }
}

function remapDiscussionIdInRecord(
  value: unknown,
  sourceDiscussionId: string,
  targetDiscussionId: string,
): Record<string, unknown> | null {
  if (!isObjectRecord(value) || value.discussionId !== sourceDiscussionId) return null;
  return { ...value, discussionId: targetDiscussionId };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function mergeAgentSessionStates(
  db: Database,
  sourceSessionId: string,
  targetSessionId: string,
): Promise<void> {
  const sourceStates = await db
    .select()
    .from(agentSessionStates)
    .where(eq(agentSessionStates.sessionId, sourceSessionId))
    .limit(1000);
  for (const sourceState of sourceStates) {
    const [targetState] = await db
      .select()
      .from(agentSessionStates)
      .where(
        and(
          eq(agentSessionStates.agentId, sourceState.agentId),
          eq(agentSessionStates.sessionId, targetSessionId),
        ),
      )
      .limit(1);
    if (targetState) {
      await db
        .update(agentSessionStates)
        .set(mergeAgentSessionStateRows(sourceState, targetState))
        .where(eq(agentSessionStates.id, targetState.id));
      await db.delete(agentSessionStates).where(eq(agentSessionStates.id, sourceState.id));
      continue;
    }
    await db
      .update(agentSessionStates)
      .set({ sessionId: targetSessionId, updatedAt: new Date() })
      .where(eq(agentSessionStates.id, sourceState.id));
  }
}

type AgentSessionStateRow = typeof agentSessionStates.$inferSelect;

function mergeAgentSessionStateRows(
  sourceState: AgentSessionStateRow,
  targetState: AgentSessionStateRow,
): Partial<typeof agentSessionStates.$inferInsert> {
  const sourceTs = stateTimestamp(sourceState);
  const targetTs = stateTimestamp(targetState);
  const preferred = sourceTs >= targetTs ? sourceState : targetState;
  const fallback = preferred === sourceState ? targetState : sourceState;
  const sdkSessionId = preferred.sdkSessionId ?? null;

  return {
    runtimeBackend: preferred.runtimeBackend ?? fallback.runtimeBackend ?? null,
    sdkSessionId,
    sdkSessionMachineId: sdkSessionId ? (preferred.sdkSessionMachineId ?? null) : null,
    workspacePath: preferred.workspacePath ?? fallback.workspacePath ?? null,
    worktreeBranch: preferred.worktreeBranch ?? fallback.worktreeBranch ?? null,
    adhocWorkDir: preferred.adhocWorkDir ?? fallback.adhocWorkDir ?? null,
    summary: preferred.summary ?? fallback.summary ?? null,
    lastRunAt: latestDate(sourceState.lastRunAt, targetState.lastRunAt),
    updatedAt: new Date(),
  };
}

function stateTimestamp(state: AgentSessionStateRow): number {
  return (
    state.lastRunAt?.getTime() ??
    state.updatedAt?.getTime() ??
    state.createdAt?.getTime() ??
    0
  );
}

function latestDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
}

export async function upgradeProvisionalSession(
  db: Database,
  provisionalKey: string,
  threadIds: string | string[],
  tenant: string,
  chatId: string,
): Promise<void> {
  // Find the provisional session
  const existing = await db
    .select()
    .from(sessions)
    .where(eq(sessions.sessionKey, provisionalKey))
    .limit(1);

  if (existing.length === 0) return;

  await aliasThreadKeysForSession(db, existing[0].id, threadIds, tenant, chatId);
}

async function getOrCreateSession(
  db: Database,
  key: string,
  chatId: string,
  scope: string,
  defaults: SessionDefaults,
  _createdBy?: string,
): Promise<ResolveResult> {
  // Try to find existing
  const existing = await db.select().from(sessions).where(eq(sessions.sessionKey, key)).limit(1);

  if (existing.length > 0) {
    return resolveExistingSession(db, existing[0], defaults);
  }

  // Seed the new session with the configured default working directory, if any.
  // Worker stickiness picks this up on the first task and runs it via passthrough.
  // Runtime is NOT seeded from chat config: with /chat set-runtime removed, the
  // runtime comes from agent/profile defaults and per-task card selection only.
  const defaultWorkDir = defaults.defaultWorkDir ?? readDefaultWorkDirEnv();

  const [created] = await db
    .insert(sessions)
    .values({
      sessionKey: key,
      chatId,
      scope,
      status: 'active',
      adhocWorkDir: defaultWorkDir,
    })
    .onConflictDoNothing({ target: sessions.sessionKey })
    .returning();

  if (!created) {
    const [conflicting] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.sessionKey, key))
      .limit(1);
    if (conflicting) {
      return resolveExistingSession(db, conflicting, defaults);
    }
    throw new Error(`Failed to create or resolve session for key ${key}`);
  }

  return {
    sessionId: created.id,
    sessionKey: created.sessionKey,
    isNew: true,
    scope: created.scope,
  };
}

async function readSessionDefaults(
  db: Database,
  tenant: string,
  chatId: string,
): Promise<SessionDefaults> {
  const [config] = await db
    .select({
      defaultWorkDir: chatConfigs.defaultWorkDir,
    })
    .from(chatConfigs)
    .where(and(eq(chatConfigs.tenantKey, tenant), eq(chatConfigs.chatId, chatId)))
    .limit(1);

  return {
    defaultWorkDir: config?.defaultWorkDir ?? null,
  };
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function normalizeThreadSessionCandidate(
  inputs: SessionKeyInputs,
  candidateId: string | undefined,
): string | undefined {
  if (!candidateId) return undefined;
  if (candidateId === inputs.messageId) {
    return inputs.isGroup && candidateId.startsWith('om_') ? undefined : candidateId;
  }
  return inputs.referencedImageMessageIds.has(candidateId) ? undefined : candidateId;
}
