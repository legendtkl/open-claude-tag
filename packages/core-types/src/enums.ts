export enum TaskStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  RUNNING = 'running',
  WAITING_APPROVAL = 'waiting_approval',
  WAITING_DELEGATION = 'waiting_delegation',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * Single source of truth for the set of runtime backend NAMES the platform
 * recognizes. Every schema/enum/type that enumerates runtimes derives from this
 * const, so adding a runtime is centralized here instead of editing the same
 * literal across ~10 files (issue #16). (The `RuntimeBackend` enum mirror below
 * must also be updated to stay in lockstep — a unit test enforces that.)
 *
 * Zod-free on purpose: this is the lowest layer every package can import without
 * pulling in zod. NOTE: these are the PERSISTED runtime NAMES (underscore form,
 * e.g. `claude_code`). A runtime descriptor's `id` (hyphen form, e.g.
 * `claude-code`) is a SEPARATE concept and must NOT be conflated with a name.
 */
export const KNOWN_RUNTIME_NAMES = ['claude_code', 'codex'] as const;

/** A recognized runtime backend name (member of {@link KNOWN_RUNTIME_NAMES}). */
export type RuntimeName = (typeof KNOWN_RUNTIME_NAMES)[number];

/**
 * Enum mirror of {@link KNOWN_RUNTIME_NAMES} retained for existing consumers.
 * Its values MUST stay in lockstep with `KNOWN_RUNTIME_NAMES` — a unit test
 * asserts `Object.values(RuntimeBackend)` deep-equals `[...KNOWN_RUNTIME_NAMES]`.
 */
export enum RuntimeBackend {
  CLAUDE_CODE = 'claude_code',
  CODEX = 'codex',
}

export enum SessionStatus {
  ACTIVE = 'active',
  IDLE = 'idle',
  ARCHIVED = 'archived',
  EXPIRED = 'expired',
}

export enum SessionScope {
  P2P = 'p2p',
  GROUP_MAIN = 'group-main',
  GROUP_MANUAL = 'group-manual',
  THREAD = 'thread',
}

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
  TOOL = 'tool',
}

export enum UserRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  USER = 'user',
  OBSERVER = 'observer',
}

export enum IntentType {
  CHAT_REPLY = 'chat_reply',
  ANALYSIS = 'analysis',
  RESEARCH = 'research',
  OPS_TASK = 'ops_task',
  SELF_IMPROVEMENT = 'self_improvement',
  SELF_DEV = 'self_dev',
}

export enum MemoryScopeType {
  SESSION = 'session',
  USER = 'user',
  GROUP = 'group',
  SYSTEM = 'system',
  AGENT = 'agent',
  AGENT_SESSION = 'agent_session',
}

export enum MemoryType {
  SUMMARY = 'summary',
  FACT = 'fact',
  PREFERENCE = 'preference',
  INSTRUCTION = 'instruction',
  DECISION = 'decision',
}

export enum MemoryStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  DELETED = 'deleted',
}

export enum ChangeRequestStatus {
  DRAFT = 'draft',
  PLANNED = 'planned',
  PATCHED = 'patched',
  VERIFIED = 'verified',
  WAITING_APPROVAL = 'waiting_approval',
  APPLIED = 'applied',
  ROLLED_BACK = 'rolled_back',
  FAILED = 'failed',
}

export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

export enum ChangeTargetType {
  AGENT = 'agent',
  WORKFLOW = 'workflow',
  PROMPT = 'prompt',
  CONFIG = 'config',
  CODE = 'code',
}

export enum ArtifactType {
  CODE = 'code',
  CONFIG = 'config',
  DOC = 'doc',
  REPORT = 'report',
  LOG = 'log',
  PATCH = 'patch',
}

export enum AuditSeverity {
  INFO = 'info',
  WARN = 'warn',
  CRITICAL = 'critical',
}

export enum InboundEventStatus {
  RECEIVED = 'received',
  PROCESSED = 'processed',
  DUPLICATE = 'duplicate',
}

export enum RuntimeMode {
  ONE_SHOT = 'one_shot',
  PERSISTENT = 'persistent',
}
