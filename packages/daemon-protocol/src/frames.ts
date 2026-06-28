import { z } from 'zod';
import { TaskSpecSchema, RuntimeEventSchema, ArtifactRefSchema } from '@open-tag/core-types';

/**
 * Wire protocol frame schemas (design §6, decision D4).
 *
 * Every WebSocket message is a JSON text frame with a common envelope
 * `{ v, type, id, ts }` plus a per-`type` payload. The full message is a zod
 * discriminated union over `type`, so malformed frames are rejected wholesale
 * and never half-applied at either end.
 *
 * `TaskSpecSchema`, `RuntimeEventSchema`, and `ArtifactRefSchema` are reused
 * verbatim from `@open-tag/core-types` — the runtime event stream IS the data
 * plane (D12), so the same schema validates events on both sides of the wire.
 */

/** Protocol envelope version. Bumped only on breaking wire changes. */
export const ENVELOPE_VERSION = 1 as const;

/**
 * Fields shared by every frame. Merged into each frame variant so the resulting
 * discriminated union still discriminates on `type`.
 */
const envelopeShape = {
  /** Envelope version; always `1` for this build. */
  v: z.literal(ENVELOPE_VERSION),
  /** Per-message unique id (uuid). */
  id: z.string().uuid(),
  /** Emission timestamp, ISO 8601. */
  ts: z.string().datetime(),
};

// ── Sub-schemas ──

export const DAEMON_FEATURE_RUNTIME_ENV = 'runtime_env' as const;
/**
 * Daemon resolves a stable per-agent home (`~/.open-claude-tag/agents/<agentId>`) on
 * ITS filesystem when a dispatch carries `workdirHints.agentId` and no explicit
 * workdir hint resolves. Servers gate the agent-home display on this feature so
 * the task card never names a directory an older daemon did not create.
 */
export const DAEMON_FEATURE_AGENT_HOME = 'agent_home' as const;
export const DaemonFeatureSchema = z.enum([
  DAEMON_FEATURE_RUNTIME_ENV,
  DAEMON_FEATURE_AGENT_HOME,
]);

/** Runtimes this server recognizes when validating a daemon's advertisement. */
const KNOWN_RUNTIMES = ['claude_code', 'codex'] as const;

/** Machine capabilities advertised on `hello` and at pairing. */
export const CapabilitiesSchema = z.object({
  // Tolerate unknown/legacy runtime strings (e.g. a not-yet-upgraded daemon still
  // advertising 'coco') and filter them out, so a rolling daemon upgrade never
  // fails `hello`/pairing capability validation. New runtimes are forward-compatible
  // the same way.
  runtimes: z
    .array(z.string())
    .default([])
    .transform((rs) =>
      rs.filter((r): r is (typeof KNOWN_RUNTIMES)[number] =>
        (KNOWN_RUNTIMES as readonly string[]).includes(r),
      ),
    ),
  features: z.array(DaemonFeatureSchema).default([]),
  platform: z.string().optional(),
  hostname: z.string().optional(),
  daemonVersion: z.string().optional(),
  protocolVersion: z.number().int().optional(),
});

/** Workdir hints mirror the worker's session → chat → env workdir chain (D6). */
export const WorkdirHintsSchema = z.object({
  confirmedWorkDir: z.string().optional(),
  adhocWorkDir: z.string().optional(),
  defaultWorkDir: z.string().optional(),
  readOnly: z.boolean().optional(),
  /**
   * Acting agent id. When no explicit workdir hint resolves, a daemon with the
   * `agent_home` feature runs the dispatch in a stable machine-local per-agent
   * home (`~/.open-claude-tag/agents/<agentId>`) instead of the ephemeral dispatch
   * scratch, mirroring the worker's server-local `generic` fallback. Older
   * daemons strip the unknown key and keep the scratch behavior.
   */
  agentId: z.string().optional(),
});

const RuntimeEnvKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'runtimeEnv keys must be valid environment variable names');
export const RuntimeEnvSchema = z.record(RuntimeEnvKeySchema, z.string());

/** Inline image attachment (base64, ≤10 MB enforced by the dispatcher, D11). */
export const InlineImageSchema = z.object({
  name: z.string(),
  base64: z.string(),
});

const RuntimeBackendSchema = z.enum(['claude_code', 'codex']);
const DispatchModeSchema = z.enum(['prepare_execute', 'resume']);

/** Reasons a server may reject a daemon at `hello` time. */
export const HelloErrorCodeSchema = z.enum(['protocol_incompatible', 'revoked', 'superseded']);

// ── Frame variants ──

/** d→s: first frame after auth; drives resume/`task_lost` reconciliation (D12). */
export const HelloFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('hello'),
  machineId: z.string(),
  protocolVersion: z.number().int(),
  daemonVersion: z.string(),
  capabilities: CapabilitiesSchema,
  runningDispatchIds: z.array(z.string()).default([]),
});

/** s→d: server tells daemon which in-flight dispatches it still wants. */
export const HelloOkFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('hello_ok'),
  heartbeatSec: z.number().positive(),
  resumeDispatchIds: z.array(z.string()).default([]),
  cancelDispatchIds: z.array(z.string()).default([]),
});

/** s→d: server refuses the connection, then closes. */
export const HelloErrorFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('hello_error'),
  code: HelloErrorCodeSchema,
  message: z.string(),
});

/** d→s: liveness ping (15 s cadence, D16). */
export const PingFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('ping'),
  seq: z.number().int().nonnegative(),
});

/** s→d: liveness pong, echoing the ping `seq`. */
export const PongFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('pong'),
  seq: z.number().int().nonnegative(),
});

/** s→d: dispatch a task to the daemon's local runtime (accept-timeout 15 s). */
export const TaskDispatchFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('task_dispatch'),
  dispatchId: z.string(),
  taskId: z.string(),
  mode: DispatchModeSchema,
  spec: TaskSpecSchema,
  sdkSessionId: z.string().optional(),
  systemPromptAppend: z.string().optional(),
  workdirHints: WorkdirHintsSchema,
  runtime: RuntimeBackendSchema,
  runtimeEnv: RuntimeEnvSchema.optional(),
  images: z.array(InlineImageSchema).optional(),
});

/** d→s: the daemon accepted the dispatch and started execution. */
export const TaskAcceptedFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('task_accepted'),
  dispatchId: z.string(),
});

/** d→s: the daemon refused the dispatch; the worker fails the task with `reason`. */
export const TaskRejectedFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('task_rejected'),
  dispatchId: z.string(),
  reason: z.string(),
});

/** d→s: one streamed runtime event, seq-numbered for ordered delivery (D12). */
export const TaskEventFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('task_event'),
  dispatchId: z.string(),
  seq: z.number().int().nonnegative(),
  event: RuntimeEventSchema,
});

/** s→d: cumulative acknowledgement of received events up to `lastSeq`. */
export const EventAckFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('event_ack'),
  dispatchId: z.string(),
  lastSeq: z.number().int().nonnegative(),
});

/** d→s: daemon restarted and no longer knows this dispatch ⇒ server fails it now. */
export const TaskLostFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('task_lost'),
  dispatchId: z.string(),
});

/** s→d: cancel an in-flight dispatch (maps to `adapter.cancel`). */
export const TaskCancelFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('task_cancel'),
  dispatchId: z.string(),
  force: z.boolean().optional(),
});

/** d→s: artifact references produced by a terminal dispatch (refs only). */
export const ArtifactsFrameSchema = z.object({
  ...envelopeShape,
  type: z.literal('artifacts'),
  dispatchId: z.string(),
  refs: z.array(ArtifactRefSchema),
});

/** Discriminated union over every frame `type`. */
export const FrameSchema = z.discriminatedUnion('type', [
  HelloFrameSchema,
  HelloOkFrameSchema,
  HelloErrorFrameSchema,
  PingFrameSchema,
  PongFrameSchema,
  TaskDispatchFrameSchema,
  TaskAcceptedFrameSchema,
  TaskRejectedFrameSchema,
  TaskEventFrameSchema,
  EventAckFrameSchema,
  TaskLostFrameSchema,
  TaskCancelFrameSchema,
  ArtifactsFrameSchema,
]);

// ── Inferred TS types ──

export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type DaemonFeature = z.infer<typeof DaemonFeatureSchema>;
export type WorkdirHints = z.infer<typeof WorkdirHintsSchema>;
export type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>;
export type InlineImage = z.infer<typeof InlineImageSchema>;
export type HelloErrorCode = z.infer<typeof HelloErrorCodeSchema>;

export type HelloFrame = z.infer<typeof HelloFrameSchema>;
export type HelloOkFrame = z.infer<typeof HelloOkFrameSchema>;
export type HelloErrorFrame = z.infer<typeof HelloErrorFrameSchema>;
export type PingFrame = z.infer<typeof PingFrameSchema>;
export type PongFrame = z.infer<typeof PongFrameSchema>;
export type TaskDispatchFrame = z.infer<typeof TaskDispatchFrameSchema>;
export type TaskAcceptedFrame = z.infer<typeof TaskAcceptedFrameSchema>;
export type TaskRejectedFrame = z.infer<typeof TaskRejectedFrameSchema>;
export type TaskEventFrame = z.infer<typeof TaskEventFrameSchema>;
export type EventAckFrame = z.infer<typeof EventAckFrameSchema>;
export type TaskLostFrame = z.infer<typeof TaskLostFrameSchema>;
export type TaskCancelFrame = z.infer<typeof TaskCancelFrameSchema>;
export type ArtifactsFrame = z.infer<typeof ArtifactsFrameSchema>;

/** Any valid protocol frame. */
export type Frame = z.infer<typeof FrameSchema>;
/** The string literal `type` of any frame. */
export type FrameType = Frame['type'];

// ── Frame size cap ──

/**
 * Maximum serialized frame size in bytes (16 MiB).
 *
 * Sized to admit the largest legitimate frame: a `task_dispatch` carrying a
 * 10 MB inline image (D11) grows to ~13.4 MB after base64 plus JSON overhead.
 * A 1 MB cap would contradict the image design and silently drop valid
 * dispatches (codex review finding #8). Senders must preflight with
 * {@link validateFrameSize} and degrade (drop images / truncate event data)
 * rather than emit a frame the peer will reject.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Returns true when a serialized frame is within `MAX_FRAME_BYTES`.
 *
 * Accepts either the raw JSON string or a byte length. Size is measured as
 * UTF-8 bytes to match what actually crosses the socket.
 */
export function validateFrameSize(serialized: string, maxBytes: number = MAX_FRAME_BYTES): boolean {
  return Buffer.byteLength(serialized, 'utf8') <= maxBytes;
}

// ── Parse / serialize helpers ──

/** Result of {@link parseFrame}: never throws, always discriminated. */
export type ParseFrameResult = { ok: true; frame: Frame } | { ok: false; error: string };

/**
 * Validates an already-decoded JSON value against {@link FrameSchema}.
 *
 * Never throws — malformed input returns `{ ok: false, error }` so callers can
 * reject the frame and count strikes (failure-mode matrix §9) instead of
 * crashing the socket handler.
 */
export function parseFrame(json: unknown): ParseFrameResult {
  const result = FrameSchema.safeParse(json);
  if (result.success) {
    return { ok: true, frame: result.data };
  }
  return { ok: false, error: result.error.message };
}

/**
 * Parses a raw text frame: enforces the size cap, decodes JSON, then validates.
 *
 * Never throws; returns the same discriminated result as {@link parseFrame}.
 */
export function parseRawFrame(raw: string, maxBytes: number = MAX_FRAME_BYTES): ParseFrameResult {
  if (!validateFrameSize(raw, maxBytes)) {
    return { ok: false, error: 'frame exceeds maximum size' };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parseFrame(decoded);
}

/**
 * Serializes a frame to its JSON wire form after validating it against the
 * schema. Throws on an invalid frame — callers always construct frames in code,
 * so a schema failure here is a programming error, not untrusted input.
 */
export function serializeFrame(frame: Frame): string {
  const validated = FrameSchema.parse(frame);
  return JSON.stringify(validated);
}
