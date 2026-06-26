/**
 * Two-tier context strategy (DeLM application, arXiv 2606.10662).
 *
 * Same agent + same kind + same machine keeps the lossless fast path: SDK
 * `resume` + the shared working directory (unchanged from today). At a
 * cross-agent, cross-kind, or cross-machine boundary — where an SDK session may
 * carry another agent's identity/system prompt, a `claude_code` SDK session
 * cannot be resumed by `codex`/`coco`, and a session pinned to one machine
 * cannot be resumed on another — the next agent instead hydrates from the
 * verified shared context.
 *
 * This generalizes the worker's existing `canResume` gate
 * (`apps/worker/src/main.ts`) by adding the runtime-kind and machine guards as a
 * single pure, testable function.
 */

export interface StoredSessionState {
  sdkSessionId?: string | null;
  /** Agent that produced `sdkSessionId`; null/undefined = legacy unowned session. */
  agentId?: string | null;
  /** Runtime backend that produced `sdkSessionId` (claude_code / codex / coco). */
  runtimeBackend?: string | null;
  /** Machine that produced `sdkSessionId`; null/undefined = server-local. */
  machineId?: string | null;
}

export interface NextTurnAgent {
  agentId?: string | null;
  runtimeBackend?: string | null;
  machineId?: string | null;
}

export interface ContextStrategyInput {
  stored: StoredSessionState;
  next: NextTurnAgent;
  adapterSupportsResume: boolean;
}

export type ContextStrategyMode = 'resume' | 'hydrate';

export interface ContextStrategy {
  mode: ContextStrategyMode;
  reason: string;
}

function normalizeKind(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeStoredKind(value: string | null | undefined): string {
  // Legacy sessions predate runtimeBackend persistence and were produced by Claude Code.
  return normalizeKind(value ?? 'claude_code');
}

/** null and undefined both mean "server-local" — the same substrate. */
function sameMachine(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

function sameAgent(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

export function selectContextStrategy(input: ContextStrategyInput): ContextStrategy {
  const { stored, next, adapterSupportsResume } = input;

  if (!stored.sdkSessionId) {
    return { mode: 'hydrate', reason: 'no stored SDK session to resume' };
  }
  if (!adapterSupportsResume) {
    return { mode: 'hydrate', reason: 'runtime adapter does not support resume' };
  }
  if (!sameAgent(stored.agentId, next.agentId)) {
    return { mode: 'hydrate', reason: 'agent changed' };
  }
  // Force hydrate on a kind change. Legacy-null stored kind is treated as
  // claude_code so a codex/coco turn does not resume an incompatible SDK session.
  const storedKind = normalizeStoredKind(stored.runtimeBackend);
  const nextKind = normalizeKind(next.runtimeBackend);
  if (storedKind && nextKind && storedKind !== nextKind) {
    return { mode: 'hydrate', reason: `runtime kind changed: ${storedKind} → ${nextKind}` };
  }
  if (!sameMachine(stored.machineId, next.machineId)) {
    return { mode: 'hydrate', reason: 'execution machine changed' };
  }

  return { mode: 'resume', reason: 'same agent, runtime kind, and machine' };
}
