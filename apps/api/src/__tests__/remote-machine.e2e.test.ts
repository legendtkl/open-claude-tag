/**
 * Stage 6.2 — E2E scenario: offline-machine fail-fast (design D8).
 *
 * Requires a running API + Worker on $API_URL (default http://localhost:3000)
 * sharing $DATABASE_URL. Run via `pnpm --filter @open-tag/api test:e2e`
 * (worktrees: `pnpm test:e2e:isolated`).
 *
 * WHAT THIS ASSERTS (and why it is the strongest honest scenario):
 *
 * The worker resolves a task's execution machine (D6) only AFTER the
 * `debugSkipExecution` early-return in `processTask` (apps/worker/src/main.ts:837,
 * which fires before machine routing at :1103). So the standard
 * `skipTaskExecution: true` debug path BYPASSES machine routing entirely — it
 * cannot exercise D8. This test therefore drives a REAL (non-skip) task in a chat
 * whose `chat_configs.default_machine_id` points at an OFFLINE machine owned by
 * the sender. Because the machine has no live daemon socket, the worker swaps in a
 * `RemoteRuntimeAdapter` whose `prepare()` fails fast with the D8 offline copy
 * BEFORE any runtime I/O — no Anthropic/Codex credentials are needed for the
 * assertion to be deterministic. The task lands in `failed` with the actionable
 * offline message persisted to `tasks.error_message`.
 *
 * The full remote COMPLETION path (bound machine completes a task, machine footer
 * asserted) is intentionally NOT attempted here: the e2e harness has no in-process
 * daemon to honestly serve the dispatch, and standing one up would be a Rube
 * Goldberg machine. Scenario (b) of the 6.1 cross-end integration suite already
 * covers the full dispatch→events→completed loop through both real ends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, machines, chatConfigs, tasks, sessions } from '@open-tag/storage';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL;
const TENANT_KEY = 'default';
const OWNER_OPEN_ID = `ou_remote_machine_e2e_${Date.now()}`;
const CHAT_ID = `debug_remote_machine_${Date.now()}`;
const MACHINE_NAME = `e2e-offline-laptop-${Date.now()}`;
const GOAL = `remote machine offline fail-fast probe ${Date.now()}`;

const db = createDb(DATABASE_URL);
let machineId: string | null = null;
const createdSessionIds: string[] = [];

async function getHealth(): Promise<{ status: string }> {
  const res = await fetch(`${API_URL}/health`);
  return res.json() as Promise<{ status: string }>;
}

async function simulate(text: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/debug/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      senderOpenId: OWNER_OPEN_ID,
      chatId: CHAT_ID,
      chatType: 'p2p',
      tenantKey: TENANT_KEY,
      // NOTE: deliberately NOT skipTaskExecution — a real run is required to reach
      // machine routing. The offline check short-circuits before any runtime I/O.
    }),
  });
  return res.json() as Promise<{ ok: boolean; error?: string }>;
}

/** Poll the DB for the task created for our goal until it reaches a terminal state. */
async function waitForTerminalTask(timeoutMs = 25_000): Promise<{
  id: string;
  status: string;
  errorMessage: string | null;
  executedOnMachineId: string | null;
}> {
  const startedAt = Date.now();
  for (;;) {
    const [row] = await db
      .select({
        id: tasks.id,
        status: tasks.status,
        errorMessage: tasks.errorMessage,
        executedOnMachineId: tasks.executedOnMachineId,
        sessionId: tasks.sessionId,
      })
      .from(tasks)
      .where(eq(tasks.goal, GOAL))
      .orderBy(tasks.createdAt)
      .limit(1);
    if (row) {
      if (!createdSessionIds.includes(row.sessionId)) createdSessionIds.push(row.sessionId);
      if (row.status === 'failed' || row.status === 'completed' || row.status === 'cancelled') {
        return {
          id: row.id,
          status: row.status,
          errorMessage: row.errorMessage,
          executedOnMachineId: row.executedOnMachineId,
        };
      }
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `task for goal "${GOAL}" did not reach a terminal state in ${timeoutMs}ms ` +
          `(last status: ${row?.status ?? 'not-created'})`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required for the remote-machine e2e scenario');
  }
  const health = await getHealth();
  if (health.status !== 'ok') {
    throw new Error(`API server is not healthy: ${JSON.stringify(health)}`);
  }

  // Seed an OFFLINE machine owned by the sender, and bind it as the chat default.
  const [machine] = await db
    .insert(machines)
    .values({
      tenantKey: TENANT_KEY,
      ownerOpenId: OWNER_OPEN_ID,
      name: MACHINE_NAME,
      secretHash: 'unused-e2e-secret-hash',
      status: 'offline',
      capabilities: { runtimes: ['claude_code', 'codex'] },
      lastSeenAt: new Date(Date.now() - 5 * 60_000),
    })
    .returning({ id: machines.id });
  machineId = machine.id;

  await db
    .insert(chatConfigs)
    .values({
      tenantKey: TENANT_KEY,
      chatId: CHAT_ID,
      defaultMachineId: machineId,
    })
    .onConflictDoUpdate({
      target: [chatConfigs.tenantKey, chatConfigs.chatId],
      set: { defaultMachineId: machineId, updatedAt: new Date() },
    });
});

afterAll(async () => {
  // Clean up seeded rows so reruns and the shared isolated DB stay tidy. Sessions
  // reference the machine via bound_machine_id (ON DELETE SET NULL) and tasks via
  // executed_on_machine_id (ON DELETE SET NULL), so deleting the machine is safe.
  try {
    await db.delete(chatConfigs).where(
      and(eq(chatConfigs.tenantKey, TENANT_KEY), eq(chatConfigs.chatId, CHAT_ID)),
    );
    if (machineId) {
      await db.delete(machines).where(eq(machines.id, machineId));
    }
    for (const sessionId of createdSessionIds) {
      await db.delete(tasks).where(eq(tasks.sessionId, sessionId));
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    }
  } catch {
    // best-effort cleanup
  }
});

describe('E2E: remote machine routing (D8 offline fail-fast)', () => {
  it('fails a task fast with the actionable offline-machine copy when the bound machine has no daemon', async () => {
    const sent = await simulate(GOAL);
    expect(sent.ok).toBe(true);

    const task = await waitForTerminalTask();

    // The task failed (fail-fast), not completed — the offline machine could not
    // accept the dispatch and there was no silent server-local fallback (D8).
    expect(task.status).toBe('failed');

    // The actionable D8 copy is persisted: machine name + last-seen + the npx
    // background start hint, so the failure card / message guides self-remediation.
    expect(task.errorMessage).toBeTruthy();
    const msg = task.errorMessage ?? '';
    expect(msg).toContain(`Machine "${MACHINE_NAME}" is offline`);
    expect(msg).toContain(
      'npx @open-tag/daemon@latest start --background',
    );

    // Honest audit note: `tasks.executed_on_machine_id` is written only on the
    // SUCCESS path (apps/worker/src/main.ts:1760, after execution). On the
    // offline fail-fast path the dispatch throws during prepare(), so the audit
    // column is never written — it stays NULL. We assert that here so the
    // scenario documents the real behavior rather than an aspirational one. (The
    // routing DECISION itself is proven by the failure copy naming this machine.)
    expect(task.executedOnMachineId).toBeNull();
  });
});
