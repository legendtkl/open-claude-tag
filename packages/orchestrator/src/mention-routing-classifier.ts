import type { LlmClient } from '@open-tag/llm-client';
import { isObjectRecord as isRecord } from '@open-tag/core-types';

/**
 * One agent visible to the routing LLM under a session-local short code
 * (`agent_1`, ...) — the same closed-roster pattern as HandoffCandidate: the
 * model routes by code, never by free-text name, so it cannot reach an agent
 * outside the actually-mentioned roster.
 */
export interface MentionRoutingCandidate {
  ref: string;
  agentId: string;
  handle: string;
  displayName: string;
}

export interface MentionRoutingDeferred {
  agentId: string;
  /** What the deferred agent is asked to do after the primary completes. */
  goal: string;
  /** Waiting acknowledgment posted in the chat, in the deferred agent's addressed voice. */
  ack: string;
}

export type MentionRoutingDecision =
  | { route: 'relay'; primaryAgentId: string; deferred: MentionRoutingDeferred[] }
  | { route: 'reference'; actorAgentIds: string[]; referenceAgentIds: string[] }
  | { route: 'fanout' };

const SYSTEM_PROMPT = `You route a group-chat instruction that mentions several AI agent bots.

Decide ONE of three routes:
- "relay": the message assigns work to one agent NOW (the primary) and names one or more agents whose turn comes only AFTER the primary finishes (sequencing words like 然后/完成后/做完/合并完/艾特/再/接着/then/after, or an obvious pipeline like "A implement, B review").
- "reference": an agent is mentioned only as the OWNER of an artifact to look at (e.g. "@B 看一下 @A 的 PR" — A is a reference, B acts).
- "fanout": no ordering between the mentioned agents (e.g. "@A @B 你们都看看") — everyone acts now.

Rules:
- Refer to agents ONLY by the short codes from the roster. Never invent codes.
- "relay" needs exactly one primary, and EVERY other agent in the roster MUST appear in "deferred" (no agent may be left out — if some mentioned agent is neither the primary nor sequenced after it, choose "reference" or "fanout" instead). Each deferred entry has:
  - "goal": what that agent should do once the primary finishes, as a self-contained imperative (do NOT include any @mention tokens in it).
  - "ack": a one-sentence Chinese waiting acknowledgment in that agent's voice, format like "收到，等 @<primary display name> 完成后我来<goal>". Keep it under 80 characters.
- If the sequencing is ambiguous, prefer "fanout" — a wrong wait is worse than a duplicate run.
- Mentions of humans are not in the roster; ignore them.

Return ONLY valid JSON, no markdown fences, one of:
{"route":"relay","primary":"agent_1","deferred":[{"agent":"agent_2","goal":"...","ack":"..."}]}
{"route":"reference","actors":["agent_1"],"references":["agent_2"]}
{"route":"fanout"}`;

const MAX_TEXT_CHARS = 4000;
const MAX_ACK_CHARS = 200;

export interface ClassifyMentionRoutingInput {
  /** Message text with mention tokens rendered as @DisplayName. */
  text: string;
  candidates: MentionRoutingCandidate[];
}

interface ValidationFailure {
  error: string;
}

function buildUserPrompt(input: ClassifyMentionRoutingInput): string {
  const roster = input.candidates
    .map((candidate) => `[${candidate.ref}] @${candidate.displayName} (handle: ${candidate.handle})`)
    .join('\n');
  return `Mentioned agent roster:\n${roster}\n\nMessage:\n${input.text.slice(0, MAX_TEXT_CHARS)}`;
}

function resolveRef(
  value: unknown,
  byRef: Map<string, MentionRoutingCandidate>,
): MentionRoutingCandidate | null {
  return typeof value === 'string' ? (byRef.get(value.trim()) ?? null) : null;
}

function parseDecision(
  raw: string,
  candidates: MentionRoutingCandidate[],
): MentionRoutingDecision | ValidationFailure {
  const byRef = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { error: 'Output was not valid JSON. Return ONLY the JSON object.' };
  }
  if (!isRecord(parsed)) {
    return { error: 'Output JSON must be an object.' };
  }

  if (parsed.route === 'fanout') {
    return { route: 'fanout' };
  }

  if (parsed.route === 'relay') {
    const primary = resolveRef(parsed.primary, byRef);
    if (!primary) {
      return { error: `"primary" must be one of: ${[...byRef.keys()].join(', ')}.` };
    }
    const rawDeferred = Array.isArray(parsed.deferred) ? parsed.deferred : [];
    if (rawDeferred.length === 0) {
      return { error: '"relay" requires a non-empty "deferred" array.' };
    }
    const deferred: MentionRoutingDeferred[] = [];
    const seen = new Set<string>([primary.agentId]);
    for (const entry of rawDeferred) {
      if (!isRecord(entry)) {
        return { error: 'Each "deferred" entry must be an object.' };
      }
      const target = resolveRef(entry.agent, byRef);
      if (!target) {
        return { error: `deferred "agent" must be one of: ${[...byRef.keys()].join(', ')}.` };
      }
      if (seen.has(target.agentId)) {
        return { error: `Agent ${String(entry.agent)} appears twice (or equals the primary).` };
      }
      seen.add(target.agentId);
      const goal = typeof entry.goal === 'string' ? entry.goal.trim() : '';
      if (!goal) {
        return { error: 'Each deferred entry needs a non-empty "goal".' };
      }
      const ack = typeof entry.ack === 'string' ? entry.ack.trim().slice(0, MAX_ACK_CHARS) : '';
      deferred.push({ agentId: target.agentId, goal, ack });
    }
    // A relay must account for every mentioned agent: an omitted bot would be
    // silently dropped (no task, no contract), which is never acceptable.
    const uncovered = candidates.filter((candidate) => !seen.has(candidate.agentId));
    if (uncovered.length > 0) {
      return {
        error: `"relay" must cover every roster agent; missing: ${uncovered
          .map((candidate) => candidate.ref)
          .join(', ')}. Use "reference" or "fanout" if they are not sequenced.`,
      };
    }
    return { route: 'relay', primaryAgentId: primary.agentId, deferred };
  }

  if (parsed.route === 'reference') {
    const actors = Array.isArray(parsed.actors) ? parsed.actors : [];
    const references = Array.isArray(parsed.references) ? parsed.references : [];
    const actorAgents = actors.map((ref) => resolveRef(ref, byRef));
    const referenceAgents = references.map((ref) => resolveRef(ref, byRef));
    if (actorAgents.length === 0 || actorAgents.some((agent) => agent === null)) {
      return { error: '"actors" must be a non-empty array of roster codes.' };
    }
    if (referenceAgents.length === 0 || referenceAgents.some((agent) => agent === null)) {
      return { error: '"references" must be a non-empty array of roster codes.' };
    }
    const actorIds = new Set(actorAgents.map((agent) => agent!.agentId));
    if (referenceAgents.some((agent) => actorIds.has(agent!.agentId))) {
      return { error: 'An agent cannot be both an actor and a reference.' };
    }
    return {
      route: 'reference',
      actorAgentIds: [...actorIds],
      referenceAgentIds: referenceAgents.map((agent) => agent!.agentId),
    };
  }

  return { error: '"route" must be one of "relay", "reference", "fanout".' };
}

/**
 * One LLM call (plus at most one targeted-feedback retry) deciding how a
 * multi-mention message routes. Returns null whenever a confident, validated
 * decision is unavailable — no client, timeout, malformed output twice — so the
 * caller can fall back to the deterministic lexicon route. Never throws.
 */
export async function classifyMentionRouting(
  input: ClassifyMentionRoutingInput,
  llmClient: LlmClient | null,
): Promise<MentionRoutingDecision | null> {
  if (!llmClient) return null;
  if (!input.text.trim() || input.candidates.length < 2) return null;

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(input) },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: string;
    try {
      response = await llmClient.chat(messages, {
        maxTokens: 512,
        temperature: 0,
        timeoutMs: 5000,
      });
    } catch {
      return null;
    }

    const decision = parseDecision(response, input.candidates);
    if (!('error' in decision)) {
      return decision;
    }
    messages.push(
      { role: 'assistant', content: response },
      {
        role: 'user',
        content: `Your previous output was invalid: ${decision.error} Return ONLY the corrected JSON.`,
      },
    );
  }

  return null;
}

/**
 * Per-message memo so all concurrent app deliveries of one message share a
 * single classification (and therefore a single, consistent decision). Entries
 * are evicted after `ttlMs` to bound memory; the promise itself is cached so a
 * second delivery arriving mid-flight awaits the same in-flight call.
 */
export function createMentionRoutingMemo(ttlMs = 10 * 60 * 1000): {
  classifyOnce(
    messageKey: string,
    input: ClassifyMentionRoutingInput,
    llmClient: LlmClient | null,
  ): Promise<MentionRoutingDecision | null>;
  size(): number;
} {
  const entries = new Map<string, { promise: Promise<MentionRoutingDecision | null>; at: number }>();

  function evictExpired(now: number): void {
    for (const [key, entry] of entries) {
      if (now - entry.at > ttlMs) entries.delete(key);
    }
  }

  return {
    classifyOnce(messageKey, input, llmClient) {
      const now = Date.now();
      evictExpired(now);
      const existing = entries.get(messageKey);
      if (existing) return existing.promise;
      const promise = classifyMentionRouting(input, llmClient);
      entries.set(messageKey, { promise, at: now });
      return promise;
    },
    size() {
      return entries.size;
    },
  };
}
