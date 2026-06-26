import type { machines } from '@open-tag/storage';

/**
 * Pure machine-routing resolver (design D6/D7).
 *
 * Decides which remote machine — if any — a task should execute on, mirroring
 * the worker's session → chat → env workdir chain so users carry one mental
 * model. The resolver is intentionally side-effect free: callers load the
 * candidate machine rows (the only DB access) and pass them in, so this logic is
 * trivially table-testable.
 */

export type MachineRow = typeof machines.$inferSelect;

/** Inputs that drive machine resolution, in precedence order. */
export interface ResolveTaskMachineInput {
  /**
   * Task type. `self_dev` always resolves to server-local regardless of any
   * binding (D7): the bot's own monorepo, reload tooling and worktree janitors
   * live on the server.
   */
  taskType: string;
  /**
   * The Feishu user who owns the task, used to enforce machine ownership (D13):
   * a resolved machine MUST be owned by this user. When unknown, ownership
   * cannot be verified and the machine is rejected (server-local).
   */
  ownerOpenId?: string | null;
  /** Tenant key for the task, also part of the ownership check. */
  tenantKey?: string | null;
  /** Explicit per-turn machine id (`constraints.confirmedMachine`), highest precedence. */
  confirmedMachineId?: string | null;
  /**
   * The acting agent's machine binding (`agents.machine_id`, design D-A8). The unit
   * a console user reasons about is "this agent runs on that machine", so it ranks
   * above the session/chat bindings (but below an explicit per-turn constraint).
   */
  agentMachineId?: string | null;
  /** Session binding (`sessions.bound_machine_id`). */
  sessionBoundMachineId?: string | null;
  /** Chat default (`chat_configs.default_machine_id`). */
  chatDefaultMachineId?: string | null;
  /**
   * Candidate machine rows, keyed by id. The caller loads only the rows that
   * could be selected (the ids above); the resolver picks the first that
   * matches by precedence and passes the ownership / revocation gates.
   */
  machinesById: Map<string, MachineRow>;
}

/** Why a resolution did not yield a remote machine, for logging/diagnostics. */
export type MachineResolutionReason =
  | 'self_dev'
  | 'no_binding'
  | 'not_found'
  | 'owner_mismatch'
  | 'revoked';

/**
 * Reasons that correctly resolve to server-local execution: `self_dev` always
 * runs on the server (D7) and `no_binding` means the user never asked for a
 * remote machine. EVERY other reason means the user made an explicit binding
 * that turned out invalid — those MUST fail fast (never silently fall back to
 * server-local, design D8), since local fallback could run repo-editing work on
 * the wrong substrate.
 *
 * Fail-closed by construction: {@link isInvalidBindingReason} treats anything
 * not in this set as invalid, so a future new reason defaults to fail-fast
 * rather than silently leaking to server-local. The exhaustiveness guard below
 * additionally forces each new reason to be consciously classified.
 */
const SERVER_LOCAL_REASONS = ['self_dev', 'no_binding'] as const;

/**
 * Reasons that mean an explicit-but-invalid binding (must fail fast, D8).
 * Used only at the type level by the exhaustiveness guard below (the runtime
 * decision derives from {@link SERVER_LOCAL_REASONS}), hence the `_` prefix to
 * mark it intentionally not referenced at runtime.
 */
const _INVALID_BINDING_REASONS = ['not_found', 'owner_mismatch', 'revoked'] as const;

const SERVER_LOCAL_REASON_SET: ReadonlySet<MachineResolutionReason> = new Set(
  SERVER_LOCAL_REASONS,
);

/**
 * True when `reason` is an explicit-but-invalid binding (not_found / revoked /
 * owner_mismatch) that must fail fast rather than reroute to server-local (D8).
 *
 * Fail-closed contract: ANY reason that is not a known server-local reason is
 * treated as invalid. This is the single source of truth the dispatch call site
 * shares with its tests, so the "decide local vs fail" rule cannot drift.
 */
export function isInvalidBindingReason(reason: MachineResolutionReason | undefined): boolean {
  return reason != null && !SERVER_LOCAL_REASON_SET.has(reason);
}

// Compile-time exhaustiveness guard: every MachineResolutionReason must be
// classified into exactly one of the two buckets above. Adding a new reason
// without listing it in SERVER_LOCAL_REASONS or INVALID_BINDING_REASONS makes
// this fail to type-check — a deliberate triage gate (the runtime default is
// already fail-closed via isInvalidBindingReason).
type _ClassifiedReason =
  | (typeof SERVER_LOCAL_REASONS)[number]
  | (typeof _INVALID_BINDING_REASONS)[number];
const _assertReasonsExhaustive: MachineResolutionReason extends _ClassifiedReason
  ? _ClassifiedReason extends MachineResolutionReason
    ? true
    : never
  : never = true;
void _assertReasonsExhaustive;

export interface MachineResolution {
  /** The resolved remote machine, or null when the task runs server-local. */
  machine: MachineRow | null;
  /** Diagnostic reason when `machine` is null; undefined when a machine resolved. */
  reason?: MachineResolutionReason;
}

/**
 * Returns null when `machine` may execute the task, otherwise a reason it cannot.
 * Offline machines pass this gate — they resolve and then the dispatch fails fast
 * with the D8 copy.
 *
 * Ownership (design D-A7): console-owned machines (`platformOwnerId` set) are
 * paired AND bound to a chat entirely in the admin console, where the operator is
 * trusted to bind any non-revoked machine. The chat user who @-mentions the bot is
 * just authoring a task, so the openId ownership gate (D13) does NOT apply — the
 * binding itself was already authorized in the console. The legacy openId gate is
 * retained ONLY for pre-D-A7 machines that still carry an `ownerOpenId` (no
 * `platformOwnerId`), so historical Feishu-paired rows keep their owner isolation.
 */
function isUsableMachine(
  machine: MachineRow,
  ownerOpenId?: string | null,
  tenantKey?: string | null,
): MachineResolutionReason | null {
  if (machine.status === 'revoked') {
    return 'revoked';
  }
  // Console-owned machine: ownership/binding authorized in the console (D-A7).
  // No openId check; routing follows the operator-set chat/session binding.
  if (machine.platformOwnerId) {
    return null;
  }
  // Legacy openId-owned machine: a daemon executes arbitrary code in the owner's
  // environment, so it only resolves for its own owner. A missing owner identity
  // cannot be verified and therefore fails closed.
  if (!ownerOpenId || machine.ownerOpenId !== ownerOpenId) {
    return 'owner_mismatch';
  }
  if (tenantKey != null && machine.tenantKey !== tenantKey) {
    return 'owner_mismatch';
  }
  return null;
}

/**
 * Resolve the execution machine for a task per design D6/D7/D13/D-A8.
 *
 * Precedence: explicit per-turn constraint → agent machine binding (D-A8) →
 * session binding → chat default → none (server-local). `self_dev` tasks
 * short-circuit to server-local. A candidate id that has no row, is not
 * owner-valid, or is revoked falls through to server-local rather than to the
 * next precedence level — an explicit choice the user made (including binding an
 * agent to a machine) should fail visibly, not silently reroute to another
 * machine.
 */
export function resolveTaskMachine(input: ResolveTaskMachineInput): MachineResolution {
  if (input.taskType === 'self_dev') {
    return { machine: null, reason: 'self_dev' };
  }

  const candidateId =
    nonEmpty(input.confirmedMachineId) ??
    nonEmpty(input.agentMachineId) ??
    nonEmpty(input.sessionBoundMachineId) ??
    nonEmpty(input.chatDefaultMachineId) ??
    null;

  if (!candidateId) {
    return { machine: null, reason: 'no_binding' };
  }

  const machine = input.machinesById.get(candidateId);
  if (!machine) {
    return { machine: null, reason: 'not_found' };
  }

  const gateFailure = isUsableMachine(machine, input.ownerOpenId, input.tenantKey);
  if (gateFailure) {
    return { machine: null, reason: gateFailure };
  }

  return { machine };
}

/** The distinct candidate ids in precedence order, for the caller's DB load. */
export function machineCandidateIds(input: {
  taskType: string;
  confirmedMachineId?: string | null;
  agentMachineId?: string | null;
  sessionBoundMachineId?: string | null;
  chatDefaultMachineId?: string | null;
}): string[] {
  if (input.taskType === 'self_dev') return [];
  const ids = [
    nonEmpty(input.confirmedMachineId),
    nonEmpty(input.agentMachineId),
    nonEmpty(input.sessionBoundMachineId),
    nonEmpty(input.chatDefaultMachineId),
  ].filter((id): id is string => id != null);
  return [...new Set(ids)];
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
