import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '@open-tag/storage';
import { agents, machines, sessions, chatConfigs, agentSessionStates } from '@open-tag/storage';
import type { Logger } from '@open-tag/observability';
import type { TaskSpec, RuntimeName } from '@open-tag/core-types';
import { collectTaskImageAttachments } from '@open-tag/runtime-adapters';
import {
  DAEMON_FEATURE_AGENT_HOME,
  DAEMON_FEATURE_RUNTIME_ENV,
  type InlineImage,
  type WorkdirHints,
} from '@open-tag/daemon-protocol';
import type { GatewayDispatchPort } from './daemon-gateway/dispatch-bridge.js';

/**
 * Minimal image-download contract (mirrors `ImageDownloader` from
 * runtime-adapters, which is not exported from its public index). The worker's
 * FeishuClient satisfies this shape.
 */
export interface ImageDownloader {
  downloadImage(messageId: string, imageKey: string): Promise<Buffer>;
}
import {
  isInvalidBindingReason,
  machineCandidateIds,
  resolveTaskMachine,
  type MachineRow,
  type MachineResolution,
} from './machine-routing.js';
import { RemoteRuntimeAdapter } from './remote-runtime-adapter.js';
import {
  invalidMachineBindingMessage,
  machineOfflineMessage,
  unsupportedRuntimeEnvMessage,
  unsupportedRuntimeMessage,
} from './daemon-gateway/messages.js';

/** Max inline image size for a remote dispatch (D11). */
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
/** Max number of images in one remote dispatch frame. */
const MAX_INLINE_IMAGE_COUNT = 12;
/** Max aggregate inline image bytes in one remote dispatch frame. */
const MAX_INLINE_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

export interface ResolveMachineForTaskInput {
  db: Database;
  taskType: string;
  ownerOpenId?: string | null;
  tenantKey?: string | null;
  sessionId: string;
  chatId?: string | null;
  confirmedMachineId?: string | null;
  /** Acting agent id; its `machine_id` binding is loaded and ranked per D-A8. */
  agentId?: string | null;
}

/**
 * Load the candidate machine bindings for a task and resolve the target machine
 * (D6/D7/D13/D-A8). Returns the resolution plus the raw binding ids so callers can
 * log precedence. All DB access lives here; {@link resolveTaskMachine} stays pure.
 *
 * Binding precedence (matching {@link resolveTaskMachine}): per-turn constraint →
 * agent.machine_id → session binding → chat default → server-local.
 */
export async function resolveMachineForTask(
  input: ResolveMachineForTaskInput,
): Promise<MachineResolution> {
  if (input.taskType === 'self_dev') {
    return { machine: null, reason: 'self_dev' };
  }

  const [session] = await input.db
    .select({ boundMachineId: sessions.boundMachineId })
    .from(sessions)
    .where(eq(sessions.id, input.sessionId))
    .limit(1);

  // The acting agent's machine binding (D-A8). NULL when unbound or no agent.
  let agentMachineId: string | null = null;
  if (input.agentId) {
    const [agent] = await input.db
      .select({ machineId: agents.machineId })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    agentMachineId = agent?.machineId ?? null;
  }

  let chatDefaultMachineId: string | null = null;
  if (input.chatId) {
    const [chatConfig] = await input.db
      .select({ defaultMachineId: chatConfigs.defaultMachineId })
      .from(chatConfigs)
      .where(
        and(
          eq(chatConfigs.tenantKey, input.tenantKey ?? 'default'),
          eq(chatConfigs.chatId, input.chatId),
        ),
      )
      .limit(1);
    chatDefaultMachineId = chatConfig?.defaultMachineId ?? null;
  }

  const candidateIds = machineCandidateIds({
    taskType: input.taskType,
    confirmedMachineId: input.confirmedMachineId,
    agentMachineId,
    sessionBoundMachineId: session?.boundMachineId ?? null,
    chatDefaultMachineId,
  });

  const machinesById = new Map<string, MachineRow>();
  if (candidateIds.length > 0) {
    const rows = await input.db.select().from(machines).where(inArray(machines.id, candidateIds));
    for (const row of rows) machinesById.set(row.id, row);
  }

  return resolveTaskMachine({
    taskType: input.taskType,
    ownerOpenId: input.ownerOpenId,
    tenantKey: input.tenantKey,
    confirmedMachineId: input.confirmedMachineId,
    agentMachineId,
    sessionBoundMachineId: session?.boundMachineId ?? null,
    chatDefaultMachineId,
    machinesById,
  });
}

/**
 * The action the worker should take after resolving a task's machine, decided
 * purely from the resolution and whether the daemon gateway is up.
 *
 * - `server-local` — run on the server (no binding, or a self_dev task).
 * - `remote` — dispatch to {@link machine} via the gateway.
 * - `fail-fast` — the binding is invalid or the gateway is down for a bound
 *   task; throw with {@link message}. A bound task MUST NEVER silently fall
 *   back to server-local (design D8).
 */
export type MachineDispatchDecision =
  | { kind: 'server-local' }
  | { kind: 'remote'; machine: MachineRow }
  | { kind: 'fail-fast'; message: string };

/**
 * Decide local-vs-remote-vs-fail from a {@link MachineResolution} (design D8).
 *
 * Fail-closed taxonomy:
 * - resolved machine + no gateway → fail fast (gateway down).
 * - resolved machine + gateway → remote dispatch.
 * - no machine, reason `self_dev`/`no_binding` → server-local.
 * - no machine, reason `not_found`/`revoked`/`owner_mismatch` (an explicit but
 *   invalid binding) → fail fast with an actionable message. This is the bug
 *   fix for codex finding R2-3: previously every null machine ran server-local.
 *
 * Kept pure (no DB, no gateway calls — caller passes gateway/machine liveness)
 * so the decision is unit-testable without standing up the worker.
 */
export function decideMachineDispatch(
  resolution: MachineResolution,
  daemonGatewayUp: boolean,
  machineOnline: boolean = daemonGatewayUp,
): MachineDispatchDecision {
  if (resolution.machine) {
    if (!daemonGatewayUp) {
      return {
        kind: 'fail-fast',
        message:
          `Machine "${resolution.machine.name}" is bound to this chat/session, but the ` +
          'daemon gateway is not running on this worker (it failed to start — likely a ' +
          'port conflict on DAEMON_GATEWAY_PORT). Fix the gateway or clear the chat machine ' +
          'binding in the admin console to execute tasks server-local.',
      };
    }
    if (!machineOnline) {
      return {
        kind: 'fail-fast',
        message: machineOfflineMessage(resolution.machine),
      };
    }
    return { kind: 'remote', machine: resolution.machine };
  }

  // No machine resolved. Only self_dev / no_binding legitimately run local; an
  // explicit-but-invalid binding must fail fast, not silently reroute (D8).
  if (isInvalidBindingReason(resolution.reason)) {
    return {
      kind: 'fail-fast',
      // isInvalidBindingReason guarantees a narrow reason here.
      message: invalidMachineBindingMessage(
        resolution.reason as 'not_found' | 'revoked' | 'owner_mismatch',
      ),
    };
  }
  return { kind: 'server-local' };
}

/**
 * Read the substrate that produced the session's currently stored `sdkSessionId`
 * (D15). This is the `sdk_session_machine_id` column persisted in lockstep with
 * `sdkSessionId` (the executing machine id, or NULL for a server-local turn), so
 * it stays correct across arbitrary local↔remote sequences — unlike the prior
 * approximation that scanned the per-task audit trail and went stale after a
 * remote→local turn (codex review finding #5).
 *
 * Returns `null` when the previous turn ran server-local or no row exists yet.
 */
export async function loadStoredSdkSessionMachineId(
  db: Database,
  input: { sessionId: string; agentId?: string | null },
): Promise<string | null> {
  if (input.agentId) {
    const [state] = await db
      .select({ machineId: agentSessionStates.sdkSessionMachineId })
      .from(agentSessionStates)
      .where(
        and(
          eq(agentSessionStates.agentId, input.agentId),
          eq(agentSessionStates.sessionId, input.sessionId),
        ),
      )
      .limit(1);
    return state?.machineId ?? null;
  }

  const [session] = await db
    .select({ machineId: sessions.sdkSessionMachineId })
    .from(sessions)
    .where(eq(sessions.id, input.sessionId))
    .limit(1);
  return session?.machineId ?? null;
}

/**
 * Whether the effective execution machine differs from the one that produced the
 * stored SDK session (D15). A `null` previous machine means the last turn ran
 * server-local; switching to a remote machine (or vice versa) is a substrate
 * change and clears the SDK session.
 */
export function isMachineSwitch(
  previousMachineId: string | null,
  currentMachineId: string | null,
): boolean {
  return previousMachineId !== currentMachineId;
}

export interface BuildRemoteAdapterInput {
  gateway: GatewayDispatchPort;
  machine: MachineRow;
  runtime: RuntimeName;
  workdirHints: WorkdirHints;
  runtimeEnv?: Record<string, string>;
  taskSpec: TaskSpec;
  imageDownloader?: ImageDownloader;
  logger: Logger;
}

/** Result of building a remote adapter: either an adapter or a fatal reason. */
export type BuildRemoteAdapterResult =
  | { ok: true; adapter: RemoteRuntimeAdapter }
  | { ok: false; reason: string };

/**
 * Build a {@link RemoteRuntimeAdapter} for a resolved machine, after checking the
 * runtime is supported by the machine's advertised capabilities. Image
 * attachments are downloaded server-side and inlined as base64 (≤10 MB; oversize
 * degrades to text-only with a warning, matching local non-fatal image
 * behavior, D11).
 */
export async function buildRemoteAdapter(
  input: BuildRemoteAdapterInput,
): Promise<BuildRemoteAdapterResult> {
  const supported = input.machine.capabilities?.runtimes ?? [];
  // Dispatch only a runtime the machine actually advertised. An empty advertised
  // list means "no runtime this server supports" and must fail closed rather than
  // read as unrestricted — a real online daemon always advertises at least
  // claude_code, and the hello capability schema filters out unknown/legacy
  // runtimes (e.g. a not-yet-upgraded daemon's `coco`), which could otherwise
  // normalize a non-empty advertisement down to `[]`.
  if (!supported.includes(input.runtime)) {
    return {
      ok: false,
      reason: unsupportedRuntimeMessage(input.machine, input.runtime, supported),
    };
  }
  const runtimeEnv = normalizeRuntimeEnvForDispatch(input.runtimeEnv);
  if (Object.keys(runtimeEnv).length > 0 && !supportsRuntimeEnv(input.machine)) {
    return {
      ok: false,
      reason: unsupportedRuntimeEnvMessage(input.machine),
    };
  }

  const images = await inlineDispatchImages({
    taskSpec: input.taskSpec,
    imageDownloader: input.imageDownloader,
    logger: input.logger,
  });

  const adapter = new RemoteRuntimeAdapter({
    gateway: input.gateway,
    machine: input.machine,
    runtime: input.runtime,
    workdirHints: input.workdirHints,
    runtimeEnv,
    images,
    buildImages: input.imageDownloader
      ? (taskSpec) =>
          inlineDispatchImages({
            taskSpec,
            imageDownloader: input.imageDownloader,
            logger: input.logger,
          })
      : undefined,
    logger: input.logger,
  });
  return { ok: true, adapter };
}

function normalizeRuntimeEnvForDispatch(
  value: Record<string, string> | undefined,
): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) && typeof entry[1] === 'string',
    ),
  );
}

function supportsRuntimeEnv(machine: MachineRow): boolean {
  const features = machine.capabilities?.features ?? [];
  return features.includes(DAEMON_FEATURE_RUNTIME_ENV);
}

/**
 * Whether the machine's daemon resolves a per-agent home for dispatches that
 * carry `workdirHints.agentId` (feature `agent_home`). Gates the agent-home
 * path shown on the task card: an older daemon runs such dispatches in its
 * ephemeral scratch, so naming the home would lie about where the task ran.
 */
export function machineSupportsAgentHome(machine: MachineRow): boolean {
  const features = machine.capabilities?.features ?? [];
  return features.includes(DAEMON_FEATURE_AGENT_HOME);
}

/**
 * Display path for a remote generic agent run's machine-local per-agent home.
 * The server cannot know the machine user's absolute home directory, so the
 * card shows the `~`-relative form the daemon expands on its side.
 */
export function remoteAgentHomeDisplayPath(agentId: string): string {
  return `~/.open-claude-tag/agents/${agentId}`;
}

async function inlineDispatchImages(input: {
  taskSpec: TaskSpec;
  imageDownloader?: ImageDownloader;
  logger: Logger;
}): Promise<InlineImage[] | undefined> {
  const attachments = collectTaskImageAttachments(input.taskSpec);
  if (attachments.length === 0 || !input.imageDownloader) return undefined;

  const images: InlineImage[] = [];
  const selectedAttachments = selectRemoteDispatchImages(input.taskSpec, attachments);
  if (attachments.length > selectedAttachments.length) {
    input.logger.warn(
      {
        requestedImageCount: attachments.length,
        includedImageCount: selectedAttachments.length,
        omittedImageCount: attachments.length - selectedAttachments.length,
      },
      'Remote dispatch image count exceeds cap, omitting extra images',
    );
  }

  let totalBytes = 0;
  for (const [index, attachment] of selectedAttachments.entries()) {
    try {
      const buffer = await input.imageDownloader.downloadImage(
        attachment.messageId,
        attachment.imageKey,
      );
      if (buffer.length > MAX_INLINE_IMAGE_BYTES) {
        input.logger.warn(
          { imageKey: attachment.imageKey, sizeBytes: buffer.length },
          'Image exceeds inline cap for remote dispatch, proceeding text-only',
        );
        continue;
      }
      if (totalBytes + buffer.length > MAX_INLINE_IMAGE_TOTAL_BYTES) {
        input.logger.warn(
          {
            imageKey: attachment.imageKey,
            sizeBytes: buffer.length,
            totalBytes,
            maxTotalBytes: MAX_INLINE_IMAGE_TOTAL_BYTES,
          },
          'Remote dispatch image total exceeds cap, omitting remaining image',
        );
        continue;
      }
      totalBytes += buffer.length;
      images.push({
        name: `image-${index + 1}-${attachment.imageKey}`,
        base64: buffer.toString('base64'),
      });
    } catch (err) {
      input.logger.warn(
        { imageKey: attachment.imageKey, err },
        'Failed to download image for remote dispatch, proceeding text-only',
      );
    }
  }
  return images.length > 0 ? images : undefined;
}

function selectRemoteDispatchImages(
  taskSpec: TaskSpec,
  attachments: ReturnType<typeof collectTaskImageAttachments>,
): ReturnType<typeof collectTaskImageAttachments> {
  if (attachments.length <= MAX_INLINE_IMAGE_COUNT) return attachments;
  const current = taskSpec.context.imageAttachment;
  if (!current) return attachments.slice(-MAX_INLINE_IMAGE_COUNT);

  const currentKey = `${current.messageId}:${current.imageKey}`;
  const selected: ReturnType<typeof collectTaskImageAttachments> = [];
  const history: ReturnType<typeof collectTaskImageAttachments> = [];
  for (const attachment of attachments) {
    const key = `${attachment.messageId}:${attachment.imageKey}`;
    if (key === currentKey) {
      selected.push(attachment);
    } else {
      history.push(attachment);
    }
  }
  const remainingSlots = MAX_INLINE_IMAGE_COUNT - selected.length;
  return selected.concat(history.slice(-Math.max(0, remainingSlots)));
}
