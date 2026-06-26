import type { AgentRecord } from '@open-tag/storage';

/**
 * The persisted Claude Code runtime backend key. Reused verbatim from
 * `agents.defaultRuntime`; never renamed (`sessions.runtimeBackend` compares it).
 * Used only as the zero-config fallback when an agent has no persisted runtime.
 */
const DEFAULT_RUNTIME_BACKEND = 'claude_code';

const ACTIVE_STATUS = 'active';

/**
 * A reference to an Identity's persona source — the existing persona pieces, not a
 * new persona store. Two concrete forms:
 *  - `{ profileId }` → the persisted `agent_profiles` row (systemPrompt/stylePrompt)
 *    a DB-backed agent carries; this is the default a composed agent resolves to.
 *  - `{ soulDir }` → an on-disk soul-loader directory (SOUL.md/STYLE.md), resolved by
 *    `loadSoul(soulDir)` in `@open-tag/runtime-adapters`.
 */
export interface SoulRef {
  profileId?: string;
  soulDir?: string;
}

/**
 * A channel scope this identity answers in. Mirrors `ChannelScope` (kind + scopeId)
 * and the `channel_observations` isolation key (`channelKind` + `scopeId`).
 */
export interface IdentityChannelBinding {
  /** Channel vendor (e.g. `lark`) — matches `ChannelScope.kind` / `channel_observations.channelKind`. */
  kind: string;
  /** Channel isolation key — matches `ChannelScope.scopeId` / `channel_observations.scopeId`. */
  scopeId: string;
}

export type IdentityBudgetWindow = 'day' | 'month';

/**
 * A declared spend/token cap. Enforced by the ambient {@link checkBudget} gate over
 * the `identity_usage` window buckets; the worker records each completed turn's
 * usage into the SAME `(identityId, window)` bucket via `recordUsage`.
 */
export interface IdentityBudget {
  tokenCap?: number;
  spendCap?: number;
  window: IdentityBudgetWindow;
}

/**
 * A first-class Identity: the project's scattered identity pieces (persona, runtime,
 * the agent's active state) composed with a channel binding, a memory scope, a
 * zero-access bundle ref, and a declared budget.
 *
 * This is an ADDITIVE read model over the `agents` table — see {@link resolveIdentity}.
 * It is not a parallel agent entity and is not separately persisted.
 */
export interface Identity {
  /** Stable identity id. Defaults to the composed `agent.id`; may be the agent handle. */
  id: string;
  /**
   * Persona source: a {@link SoulRef} into the existing persona pieces (the agent's
   * `agent_profiles` row, or a soul-loader directory), or a soul-loader directory
   * path string passed straight to `loadSoul`.
   */
  persona: SoulRef | string;
  /**
   * The PERSISTED runtime backend key (`claude_code` | `codex` | ...), reused from
   * `agents.defaultRuntime`. Identity does NOT re-implement runtime selection.
   */
  runtimeBackend: string;
  /** Channel scopes this identity answers in. Empty until bound (see {@link resolveIdentity}). */
  boundChannels: IdentityChannelBinding[];
  /**
   * The channel memory store this identity reads/writes — links to
   * `channel_observations.scopeId` (the channel memory isolation key).
   *
   * `undefined` when the identity is not yet bound to a single channel. Never `''`:
   * an empty string is a valid isolation key, so defaulting it would silently make
   * an unbound identity share one global memory bucket.
   */
  memoryScopeId?: string;
  /**
   * Reference to an access bundle (plugins + credential refs). `undefined` ⇒
   * ZERO-ACCESS: no plugins and no extra credentials. Absence means "no
   * capabilities", never "use ambient defaults". Access bundles land in a later
   * Stage-4 cut; this is a ref placeholder.
   */
  accessBundleRef?: string;
  /**
   * Spend/token cap, composed from the persisted `agents.budget`. `undefined` ⇒
   * unlimited. Enforced by the ambient {@link checkBudget} gate; the worker records
   * each completed turn's usage into the matching `identity_usage` window bucket.
   */
  budget?: IdentityBudget;
  /** Mirrors the composed agent's active state (`agent.status === 'active'`). */
  active: boolean;
}

/**
 * The structural subset of an `agents` row that an Identity is composed from. The
 * drizzle {@link AgentRecord} is assignable to this, so {@link resolveIdentity} reads
 * a real agent row — Identity is a read model OVER the `agents` table, never a fork.
 */
export interface IdentityAgentSource {
  id: string;
  handle: string;
  profileId: string;
  defaultRuntime: string | null;
  scopeType: string;
  scopeId: string;
  status: string;
  /**
   * The persisted per-agent budget cap (`agents.budget` jsonb). `null`/absent ⇒ no
   * cap = unlimited (the default). Structurally an {@link IdentityBudget}; a drizzle
   * `AgentRecord` (whose `budget` is `AgentBudget | null`) stays assignable here.
   */
  budget?: IdentityBudget | null;
}

export interface ResolveIdentityOptions {
  /** Override the identity id. Defaults to `agent.id`; pass `agent.handle` to key by handle. */
  id?: string;
  /**
   * Persona override. Defaults to `{ profileId: agent.profileId }` — the agent's
   * persisted persona profile.
   */
  persona?: SoulRef | string;
  /** Runtime backend used when `agent.defaultRuntime` is null. Defaults to `claude_code`. */
  defaultRuntimeBackend?: string;
  /**
   * Channel scopes this identity answers in. Defaults to `[]`.
   * TODO(stage-4): bind from `chat_configs` / `agent_bot_bindings`.
   */
  boundChannels?: IdentityChannelBinding[];
  /**
   * The channel memory scope (`channel_observations.scopeId`). When omitted, falls
   * back to the sole bound channel's `scopeId` ONLY when the binding is unambiguous
   * (exactly one channel); with zero or multiple bindings it stays `undefined`.
   */
  memoryScopeId?: string;
  /** Access bundle ref. Omit for ZERO-ACCESS (the default). */
  accessBundleRef?: string;
  /**
   * Budget-cap override. When omitted, {@link resolveIdentity} composes the
   * persisted per-agent cap from the agent's `budget` column.
   */
  budget?: IdentityBudget;
}

/**
 * Compose an existing agent row into a first-class {@link Identity}.
 *
 * Identity is an ADDITIVE read model: it reuses the agent's persisted id, persona
 * profile, runtime backend, and active state, and layers on the channel binding,
 * memory scope, zero-access bundle ref, and declared budget. It does NOT fork or
 * duplicate the `agents` table — there is no parallel persistence here, and runtime
 * selection / agent resolution are untouched.
 *
 * Zero-access by default: with no `accessBundleRef`, the identity carries no plugins
 * and no extra credentials.
 *
 * Pure and deterministic: no DB I/O and no wall-clock — the same agent row + options
 * always yield the same Identity.
 */
export function resolveIdentity(
  agent: IdentityAgentSource,
  options: ResolveIdentityOptions = {},
): Identity {
  const boundChannels = options.boundChannels ?? [];
  // Only auto-derive the memory scope when the binding is unambiguous, and never let
  // it be `''`: an empty isolation key would silently share one global memory bucket,
  // so a blank explicit value or a blank sole-binding scopeId collapses to undefined.
  const candidateMemoryScopeId =
    options.memoryScopeId ?? (boundChannels.length === 1 ? boundChannels[0].scopeId : undefined);
  const memoryScopeId = candidateMemoryScopeId || undefined;

  return {
    id: options.id ?? agent.id,
    persona: options.persona ?? { profileId: agent.profileId },
    runtimeBackend:
      agent.defaultRuntime ?? options.defaultRuntimeBackend ?? DEFAULT_RUNTIME_BACKEND,
    boundChannels,
    memoryScopeId,
    accessBundleRef: options.accessBundleRef,
    // Budget source: an explicit option wins (test/override), else the persisted
    // per-agent cap (`agents.budget`), else undefined = unlimited (unchanged
    // default). `null` from the column collapses to undefined.
    budget: options.budget ?? agent.budget ?? undefined,
    active: agent.status === ACTIVE_STATUS,
  };
}
