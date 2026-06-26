/**
 * Ambient proactive-posting contracts. The first ambient trigger (DESIGN §4.7a)
 * is a per-message post gate: for an *un-addressed* channel message, decide
 * whether the agent should proactively post a reply — opt-in, gated, and
 * budget-respecting. Memory-*following* is always-on and is NOT gated here; only
 * proactive *posting* is opt-in (DESIGN principle #10 / decision (f)).
 */

/**
 * The subset of channel-core's `InboundMessage` the ambient post-gate reads.
 * Declared structurally (not imported) so `@open-tag/ambient` stays
 * dependency-free of `@open-tag/channel-core` — exactly as `@open-tag/memory`'s
 * `ObservationInbound` does. A full `InboundMessage` is assignable to this by
 * TypeScript's structural typing, so the gateway can pass one in directly when
 * the gate is wired up.
 */
export interface AmbientInbound {
  /** InboundMessage.messageId — the source message a post would reply to. */
  messageId: string;
  /** InboundMessage.eventType — only `created`/`updated` are considered. */
  eventType: string;
  /** InboundMessage.occurredAt, epoch ms (carried for parity; the gate never reads wall-clock). */
  occurredAt: number;
  /** The channel isolation key; `scopeId` is the unit of per-channel ambient scope. */
  scope: { kind: string; scopeId: string; isPrivate?: boolean };
  sender: { id: string; isBot: boolean };
  content: {
    type: string;
    text?: string;
    /** A bot mention ⇒ the message is addressed; the orchestrator handles those directly. */
    mentions?: Array<{ type: string; id?: string }>;
  };
}

export interface BudgetStatus {
  /** False ⇒ the channel/identity is at/over its spend cap; no ambient work. */
  withinBudget: boolean;
}

/**
 * Injected, possibly-async spend gate. Resolved lazily — only after the cheap
 * substantive checks pass and always before the (token-spending) judge.
 */
export type BudgetCheck = () => BudgetStatus | Promise<BudgetStatus>;

export interface AmbientJudgePrompt {
  /** The un-addressed message under consideration. */
  message: AmbientInbound;
  /** Recent per-channel memory/context the caller hydrated. */
  context: string;
  /** Which cheap heuristic flagged this message (a hint for the judge). */
  heuristic: string;
}
export interface AmbientJudgeVerdict {
  post: boolean;
  rationale: string;
}
/**
 * Optional injected LLM judge — the only gate that may spend tokens. Kept as a
 * bare function so ambient takes no hard dependency on `@open-tag/llm-client`;
 * the caller adapts whatever `LlmClient` it has into this shape.
 */
export type AmbientJudge = (prompt: AmbientJudgePrompt) => Promise<AmbientJudgeVerdict>;

export interface AmbientPostInput {
  /** The un-addressed inbound message the gate decides on. */
  message: AmbientInbound;
  /** Recent per-channel memory/context, already hydrated by the caller. */
  context: string;
  /**
   * Per-channel toggle — compute via {@link isAmbientEnabled}. Fail-closed:
   * anything but an explicit `true` is treated as OFF.
   */
  ambientEnabled: boolean;
  /** Spend gate — a resolved status or an injected (possibly async) check. */
  budget: BudgetStatus | BudgetCheck;
  /** Optional injected judge confirming the post is worth making. */
  judge?: AmbientJudge;
}

export interface AmbientDecision {
  shouldPost: boolean;
  /** Names the first failing gate, or — when posting — the passing signal. */
  reason: string;
}
