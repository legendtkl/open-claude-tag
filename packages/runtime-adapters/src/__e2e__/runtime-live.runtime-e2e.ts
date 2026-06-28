import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { RuntimeEvent, TaskResult, TaskSpec } from '@open-tag/core-types';
import { CodexAdapter, ClaudeCodeAdapter } from '../index.js';
import { createWorkspace, cleanupWorkspace } from '../workspace.js';
import type { RuntimeAdapter, WorkspaceContext } from '../types.js';
import { codexCredsPresent, claudeCredsPresent } from './runtime-live-creds.js';

/**
 * OPT-IN live runtime e2e. NOT part of the default suite — runs ONLY via the
 * `test:runtime:e2e` command (explicit `--config vitest.runtime-e2e.config.ts`).
 * The filename uses `.runtime-e2e.ts` (not `.test.ts`/`.spec.ts`) so vitest's
 * default include never picks it up. It makes REAL, billable model calls.
 *
 * Each runtime self-skips when its credentials are absent (see
 * runtime-live-creds.ts). A skipped runtime is reported as skipped, not failed.
 *
 * Network is the operator's responsibility and is NEVER set in code: Codex needs
 * NO proxy; Claude Code needs an HTTPS proxy reachable to api.anthropic.com.
 */

// In-test watchdog fires below the vitest backstop so we can force-cancel the
// adapter stream and still run workspace cleanup before the test fails.
const TASK_WATCHDOG_MS = 175_000;
// After a watchdog cancel, give the stream a bounded chance to settle so cleanup
// does not race a still-shutting-down subprocess. Stays under the 200s backstop.
const WATCHDOG_DRAIN_GRACE_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LiveRunResult {
  token: string;
  completed?: TaskResult;
  failure?: string;
  seen: Set<string>;
}

function makeSpec(token: string, runtimeHint: 'codex' | 'claude_code'): TaskSpec {
  return {
    taskId: randomUUID(),
    sessionId: randomUUID(),
    taskType: 'chat_reply',
    goal: `Reply with exactly this token and nothing else: ${token}`,
    runtimeHint,
    constraints: {
      timeoutSec: 1800,
      approvalRequired: false,
      writeScope: [] as string[],
      networkPolicy: 'restricted',
    },
    context: {
      systemPrompt: 'You are a test harness. Output only exactly what the task asks for.',
      recentTurns: [] as unknown[],
    },
  } satisfies TaskSpec;
}

async function runLiveTask(
  adapter: RuntimeAdapter,
  runtimeHint: 'codex' | 'claude_code',
): Promise<LiveRunResult> {
  const runId = `runtime-e2e-${runtimeHint}-${randomUUID()}`;
  const token = `RUNTIME_E2E_OK_${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const workspace: WorkspaceContext = { ...(await createWorkspace(runId)), readOnly: true };
  const spec = makeSpec(token, runtimeHint);

  const seen = new Set<string>();
  let completed: TaskResult | undefined;
  let failure: string | undefined;

  try {
    const handle = await adapter.prepare(spec, workspace);

    const drain = (async () => {
      for await (const ev of adapter.execute(handle, spec) as AsyncGenerator<RuntimeEvent>) {
        seen.add(ev.type);
        if (ev.type === 'completed') completed = ev.result;
        if (ev.type === 'failed') failure = ev.error ?? 'failed';
      }
    })();
    // Swallow any late rejection after the watchdog force-cancels the stream.
    drain.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void (async () => {
          // Force-cancel and AWAIT it, then give the stream a bounded window to
          // settle, so the outer cleanup does not race a live subprocess.
          await adapter.cancel(handle.executionId, { force: true }).catch(() => {});
          await Promise.race([drain, delay(WATCHDOG_DRAIN_GRACE_MS)]);
          reject(new Error(`runtime ${runtimeHint} did not finish within ${TASK_WATCHDOG_MS} ms`));
        })();
      }, TASK_WATCHDOG_MS);
    });

    try {
      await Promise.race([drain, watchdog]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    await cleanupWorkspace(runId).catch(() => {});
  }

  return { token, completed, failure, seen };
}

function assertCompleted({ token, completed, failure, seen }: LiveRunResult): void {
  expect(failure, `runtime emitted a failed event: ${failure}`).toBeUndefined();
  expect(completed, `no completed event (saw: ${[...seen].join(', ') || 'nothing'})`).toBeDefined();
  const result = completed as TaskResult;
  expect(result.taskId, 'completed.result.taskId missing').toBeTruthy();
  expect(result.status).toBe('completed');

  const text = result.output?.text ?? '';
  // Token-echo proof: confirms the real SDK received the prompt and the model
  // echoed the unique token. We assert containment, not exact equality — a real
  // model may add punctuation/whitespace/wrapping, and this billable one-shot
  // verifies execution, not exact formatting.
  expect(text, `completed.output.text did not contain token ${token}: ${JSON.stringify(text)}`).toContain(
    token,
  );

  const metrics = result.metrics;
  expect(metrics, 'completed.result.metrics missing').toBeDefined();
  for (const key of ['durationMs', 'tokenIn', 'tokenOut', 'estimatedCostUsd'] as const) {
    expect(Number.isFinite(metrics[key]), `metrics.${key} is not a finite number`).toBe(true);
  }
  // A real chat reply must have consumed prompt tokens and produced reply
  // tokens; asserting > 0 proves usage actually flowed from the SDK rather than
  // an adapter's zero default.
  expect(metrics.tokenIn, 'metrics.tokenIn should be > 0 for a real call').toBeGreaterThan(0);
  expect(metrics.tokenOut, 'metrics.tokenOut should be > 0 for a real call').toBeGreaterThan(0);
  expect(metrics.estimatedCostUsd).toBeGreaterThanOrEqual(0);
}

describe('runtime live e2e (opt-in; real model calls)', () => {
  it.skipIf(!codexCredsPresent())(
    'codex runtime executes a chat_reply end-to-end via the real SDK',
    async () => {
      assertCompleted(await runLiveTask(new CodexAdapter(), 'codex'));
    },
  );

  it.skipIf(!claudeCredsPresent())(
    'claude_code runtime executes a chat_reply end-to-end via the real SDK',
    async () => {
      // Empty baseUrl/authToken: the adapter only injects them when truthy, so
      // it falls back to the operator's ambient env / local login — no creds in
      // code.
      assertCompleted(
        await runLiveTask(new ClaudeCodeAdapter({ baseUrl: '', authToken: '' }), 'claude_code'),
      );
    },
  );
});
