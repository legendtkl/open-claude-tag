/**
 * Channel abstraction — vendor-neutral contracts between channel adapters
 * (e.g. Lark, Slack) and the core. A channel adapter normalizes inbound
 * platform events into {@link InboundMessage} and renders {@link OutboundMessage}
 * back out. The core never names a vendor; channel-specific payloads retreat
 * into the typed `native` escape hatch.
 */

export type ChannelKind = 'lark' | 'slack' | 'discord' | (string & {});

/** Capability flags drive graceful degradation, segmentation, and coalescing. */
export interface ChannelCapabilities {
  /** Rich interactive surface (Lark interactive card / Slack Block Kit). */
  supportsCards: boolean;
  /** Can edit an already-posted message in place → live checklist. */
  supportsStreamingEdit: boolean;
  supportsThreads: boolean;
  supportsReactions: boolean;
  /** Interactive inputs/buttons (workdir-confirm form, dropdowns, menus). */
  supportsForms: boolean;
  supportsApprovalButtons: boolean;
  supportsAttachmentsIn: ReadonlyArray<'image' | 'file' | 'audio'>;
  supportsAttachmentsOut: ReadonlyArray<'image' | 'file'>;
  maxOutboundChars: number;
  /** e.g. Slack Block Kit caps ~50 blocks; drives outbound segmentation. */
  maxOutboundElements: number;
  /** e.g. Slack chat.update ~1/s; the worker coalesces update() to this. */
  maxUpdateRateHz: number;
}

/** The per-channel isolation key for memory + access. `scopeId` is the unit of isolation. */
export interface ChannelScope {
  kind: ChannelKind;
  scopeId: string;
  /** Tenant/workspace: Slack team_id, Lark tenant key, Discord guild id. */
  installationId: string;
  threadId?: string;
  /** Excluded from cross-channel reads/flags by default. */
  isPrivate: boolean;
}

/** Neutral threading: Lark root/parent and Slack thread_ts/ts both map here. */
export interface ConversationRef {
  kind: ChannelKind;
  scopeId: string;
  threadId?: string;
  reply?: { rootId?: string; parentId?: string };
}

export interface AgentAddress {
  kind: ChannelKind;
  botId: string;
  handles: string[];
}

/** A channel emits neutral addressing tokens; the core does roster matching. */
export interface AddressingSignal {
  kind: 'bot' | 'user' | 'unknown';
  id?: string;
  raw: string;
}

export interface AttachmentRef {
  type: 'image' | 'file' | 'audio';
  id: string;
  name?: string;
  mimeType?: string;
  native?: unknown;
}
export interface LocalFile {
  path: string;
  name: string;
  mimeType?: string;
}
export interface RemoteAttachmentRef {
  type: 'image' | 'file';
  ref: string;
  native?: unknown;
}

export interface Mention {
  id: string;
  type: 'bot' | 'user';
  raw?: string;
}
export interface ReferencedMessage {
  messageId: string;
  text?: string;
  sender?: string;
  /**
   * Per-entry author/text of a merged/forwarded reference. The core assembles
   * task-goal context from these (one `author: text` line per entry). Neutral:
   * a forwarded bundle of sub-messages maps here on Slack/Discord too. Additive
   * to the existing `text`/`sender` projection, which stays byte-compatible for
   * other neutral consumers.
   */
  entries?: { author?: string; text: string }[];
}

export type InboundEventType = 'created' | 'updated' | 'deleted' | 'reaction' | 'interaction';

/** A normalized inbound message. Channel-specific ids retreat into `channel.native`. */
export interface InboundMessage {
  /** Raw provider payload escape hatch — reads are CI-lint-fenced to `channel-*` packages. */
  channel: { kind: ChannelKind; native: unknown };
  eventId: string;
  messageId: string;
  /** Event semantics — memory ingestion consumes only created/updated, with tombstone/supersede. */
  eventType: InboundEventType;
  occurredAt: number;
  dedupeKey: string;
  conversation: ConversationRef;
  scope: ChannelScope;
  sender: { id: string; displayName?: string; isBot: boolean; native?: unknown };
  content: {
    type: 'text' | 'rich_text' | 'image' | 'file' | 'command' | 'interaction';
    text?: string;
    command?: string;
    args?: string;
    /** Button/form submit (approve/reject, workdir-form). How a durable approval answer re-enters. */
    interaction?: { action: string; value: Record<string, unknown>; sourceRef?: DeliveryRef };
    mentions: Mention[];
    attachments: AttachmentRef[];
    referenced?: ReferencedMessage[];
  };
  locale?: string;
}

export interface ChecklistStep {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
}
export type RunStatus = 'running' | 'done' | 'failed';
export interface ApprovalPrompt {
  title: string;
  detail?: string;
  actions: { id: string; label: string }[];
}
export interface FormField {
  id: string;
  label: string;
  type: 'text' | 'select';
  options?: string[];
}
export interface FormAction {
  id: string;
  label: string;
}
export interface DocAnchorRef {
  docId: string;
  native?: unknown;
}
export interface AgentRef {
  id: string;
  displayName?: string;
}

/**
 * The neutral render model the core speaks; the channel renders it. Symmetric
 * with inbound: a typed `native` escape hatch + the auxiliary surfaces a worker
 * uses (form/comment/discussion/handoff). Approval is REQUEST-only; the answer
 * returns as an inbound `interaction` (durable, survives restarts).
 */
export type OutboundMessage =
  | { kind: 'text'; markdown: string }
  | { kind: 'checklist'; title: string; steps: ChecklistStep[]; status: RunStatus }
  | { kind: 'result'; markdown: string; artifacts?: RemoteAttachmentRef[] }
  | { kind: 'approval'; prompt: ApprovalPrompt }
  | { kind: 'form'; title: string; fields: FormField[]; actions: FormAction[] }
  | { kind: 'comment'; anchor: DocAnchorRef; markdown: string }
  | { kind: 'discussion'; markdown: string }
  | { kind: 'handoff'; to: AgentRef; markdown: string }
  | { kind: 'native'; payload: unknown }
  | { kind: 'error'; message: string; retryable?: boolean };

/** A handle over the N physical messages a logical message segments into. */
export interface DeliveryRef {
  kind: ChannelKind;
  logicalMessageId: string;
  revision: number;
  physicalIds: string[];
  native?: unknown;
}

/**
 * Optional controls for an outbound {@link Channel.send}. `idempotencyKey` is a
 * caller-supplied, exactly-once token: the adapter threads it into the provider's
 * dedupe slot (Lark's message `uuid`) so a retry/crash re-send of the same logical
 * message does not post a duplicate. Omit it and the adapter mints a fresh token,
 * i.e. behavior is unchanged from a send with no opts.
 */
export interface SendOptions {
  idempotencyKey?: string;
}

export interface HealthStatus {
  healthy: boolean;
  detail?: string;
}
export interface ChannelSession {
  stop(): Promise<void>;
}

/**
 * A channel adapter. `LarkChannel`/`SlackChannel` implement this with different
 * internals + capability flags; the core holds them only behind this interface.
 */
export interface Channel {
  readonly kind: ChannelKind;
  capabilities(): ChannelCapabilities;
  start(sink: (msg: InboundMessage) => Promise<void>): Promise<ChannelSession>;
  normalize(raw: unknown): InboundMessage | null;
  /** Emit neutral addressing tokens over the message; roster matching happens in the core. */
  extractAddressingSignals(msg: InboundMessage): AddressingSignal[];
  send(to: ConversationRef, msg: OutboundMessage, opts?: SendOptions): Promise<DeliveryRef>;
  update(ref: DeliveryRef, msg: OutboundMessage, opts?: { revision?: number }): Promise<DeliveryRef>;
  react?(ref: DeliveryRef, emoji: string): Promise<void>;
  uploadArtifact(file: LocalFile): Promise<RemoteAttachmentRef>;
  fetchAttachment(att: AttachmentRef, destDir: string): Promise<LocalFile>;
  resolveScope(msg: InboundMessage): ChannelScope;
  healthcheck(): Promise<HealthStatus>;
}

/** The gateway holds a registry and dispatches by `conversation.kind`. */
export interface ChannelRegistry {
  register(channel: Channel): void;
  get(kind: ChannelKind): Channel | undefined;
  all(): Channel[];
}
