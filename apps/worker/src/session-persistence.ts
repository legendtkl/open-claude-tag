import type { Database } from '@open-tag/storage';
import { sessions, upsertAgentSessionState } from '@open-tag/storage';
import { eq } from 'drizzle-orm';

/**
 * Persist session state after task execution.
 *
 * runtimeBackend is always written so that subsequent messages in the same
 * thread inherit the runtime chosen for the first task (e.g. codex).
 * sdkSessionId is only written when a new value is available (claude_code
 * multi-turn resume); omitting it from the update leaves any existing value
 * in the DB untouched. When a new sdkSessionId IS written, the substrate that
 * produced it (`sdkSessionMachineId`: the executing machine id, or NULL for
 * server-local) is written in the SAME statement so the D15 machine-switch
 * check reads the substrate that actually owns the stored SDK state.
 */
export async function persistSessionState(
  db: Database,
  sessionId: string,
  runtimeBackend: string,
  sdkSessionId: string | null,
  sdkSessionMachineId: string | null,
): Promise<void> {
  await db
    .update(sessions)
    .set({
      runtimeBackend,
      ...(sdkSessionId != null ? { sdkSessionId, sdkSessionMachineId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId));
}

export interface PersistWorkerRuntimeStateInput {
  sessionId: string;
  agentId?: string;
  runtimeBackend: string;
  sdkSessionId: string | null;
  /**
   * The machine that produced `sdkSessionId` (the just-executed machine id, or
   * NULL for a server-local turn). Written in lockstep with `sdkSessionId`.
   */
  sdkSessionMachineId: string | null;
  workspacePath?: string | null;
  worktreeBranch?: string | null;
  adhocWorkDir?: string | null;
}

export async function persistWorkerRuntimeState(
  db: Database,
  input: PersistWorkerRuntimeStateInput,
): Promise<void> {
  if (!input.agentId) {
    await persistSessionState(
      db,
      input.sessionId,
      input.runtimeBackend,
      input.sdkSessionId,
      input.sdkSessionMachineId,
    );
    return;
  }

  await upsertAgentSessionState(db, {
    agentId: input.agentId,
    sessionId: input.sessionId,
    runtimeBackend: input.runtimeBackend,
    ...(input.sdkSessionId != null
      ? { sdkSessionId: input.sdkSessionId, sdkSessionMachineId: input.sdkSessionMachineId }
      : {}),
    workspacePath: input.workspacePath,
    worktreeBranch: input.worktreeBranch,
    adhocWorkDir: input.adhocWorkDir,
    lastRunAt: new Date(),
  });
}

export async function clearWorkerSdkSessionState(
  db: Database,
  input: { sessionId: string; agentId?: string },
): Promise<void> {
  if (input.agentId) {
    await upsertAgentSessionState(db, {
      agentId: input.agentId,
      sessionId: input.sessionId,
      sdkSessionId: null,
      sdkSessionMachineId: null,
    });
    return;
  }

  await db
    .update(sessions)
    .set({ sdkSessionId: null, sdkSessionMachineId: null, updatedAt: new Date() })
    .where(eq(sessions.id, input.sessionId));
}
