import type { AmbientDecision, AmbientInbound, AmbientPostInput, BudgetStatus } from './types.js';

/** Reject sub-trivial fragments; same skip spirit as memory's `ingestObservation`. */
const MIN_SUBSTANTIVE_CHARS = 3;

/** Collapse whitespace + trim so leading/trailing noise can't pad past the length gate. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Addressed ⇔ the message @-mentions a bot; the orchestrator handles those directly. */
function isAddressed(message: AmbientInbound): boolean {
  return (message.content.mentions ?? []).some((m) => m.type === 'bot');
}

/**
 * Common 4+ char function words excluded from topic-overlap so a generic shared
 * word (e.g. "this", "have", "with") can't, on its own, make a message look like
 * "a topic the channel cares about" and trigger a judge-less post.
 */
const STOPWORDS = new Set<string>([
  'about',
  'again',
  'also',
  'been',
  'both',
  'cannot',
  'could',
  'does',
  'doing',
  'done',
  'each',
  'else',
  'ever',
  'from',
  'gonna',
  'have',
  'here',
  'into',
  'just',
  'like',
  'more',
  'most',
  'much',
  'only',
  'over',
  'said',
  'same',
  'some',
  'such',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'very',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'would',
  'your',
  'yours',
]);

/** Lowercased significant (non-stopword) words (>= 4 chars) for cheap topic-overlap. */
function salientWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * Cheap, deterministic "worth saying" heuristic — no I/O, no wall-clock. Two
 * signals; returns the matched signal name, or `null` when nothing is worth
 * saying:
 *  - `unanswered_question` — the text asks something, or
 *  - `channel_topic` — a salient word overlaps the recent channel context.
 */
function worthSayingSignal(text: string, context: string): string | null {
  if (text.includes('?')) return 'unanswered_question';
  const ctx = salientWords(context);
  if (ctx.size > 0) {
    for (const w of salientWords(text)) {
      if (ctx.has(w)) return 'channel_topic';
    }
  }
  return null;
}

/** Resolve a budget status or an injected (possibly async) `checkBudget()`. */
async function resolveBudget(budget: AmbientPostInput['budget']): Promise<BudgetStatus> {
  return typeof budget === 'function' ? budget() : budget;
}

/**
 * The ambient per-message post gate (DESIGN §4.7a). Pure/deterministic given its
 * inputs — the budget check and LLM judge are injected, so there is no I/O or
 * wall-clock here.
 *
 * Gates run cheapest-first and short-circuit at the FIRST failure, returning a
 * precise `reason` that names the gate:
 *   1. ambient enabled for the channel  (DEFAULT OFF; anything but `true` ⇒ off)
 *   2. substantive & un-addressed        (skip bots/commands/trivial/addressed)
 *   3. within budget                     (before any spend)
 *   4. a cheap heuristic says worth-saying
 *   5. if a judge is injected, it confirms (the only token-spending step)
 *
 * Posting requires ALL gates to pass; the budget and heuristic both run before
 * the judge, so an over-budget or not-worth-saying message never reaches the LLM.
 *
 * Fail-closed: a thrown/rejected injected budget check or judge is swallowed into
 * a no-post decision (`budget_check_failed` / `judge_failed`) — a flaky dependency
 * never produces a proactive post, and never escapes to crash the always-on path.
 */
export async function evaluateAmbientPost(input: AmbientPostInput): Promise<AmbientDecision> {
  const { message, context, ambientEnabled, budget, judge } = input;

  // Gate 1 — ambient posting is opt-in; fail closed on anything but an explicit true.
  if (ambientEnabled !== true) {
    return { shouldPost: false, reason: 'ambient_disabled' };
  }

  // Gate 2 — substantive & un-addressed (same skip spirit as ingestObservation).
  if (message.eventType !== 'created' && message.eventType !== 'updated') {
    return { shouldPost: false, reason: 'unsupported_event_type' };
  }
  // Text-bearing content only. Feishu `post` messages normalize to `rich_text`
  // with the plain text already extracted into `content.text`, so accept both;
  // a rich_text with no extractable text falls through to the empty-content gate.
  if (message.content.type !== 'text' && message.content.type !== 'rich_text') {
    return { shouldPost: false, reason: 'non_text_content' };
  }
  if (message.sender.isBot) {
    return { shouldPost: false, reason: 'bot_sender' };
  }
  if (isAddressed(message)) {
    return { shouldPost: false, reason: 'addressed' };
  }
  const text = normalizeText(message.content.text ?? '');
  if (text.length === 0) {
    return { shouldPost: false, reason: 'empty_content' };
  }
  if (text.startsWith('/')) {
    return { shouldPost: false, reason: 'command' };
  }
  if (text.length < MIN_SUBSTANTIVE_CHARS) {
    return { shouldPost: false, reason: 'trivial' };
  }

  // Gate 3 — within budget, BEFORE any spend (the heuristic is free; the judge is not).
  // A failing budget check fails closed: never post when we can't confirm headroom.
  let withinBudget: boolean;
  try {
    ({ withinBudget } = await resolveBudget(budget));
  } catch {
    return { shouldPost: false, reason: 'budget_check_failed' };
  }
  if (!withinBudget) {
    return { shouldPost: false, reason: 'budget_exhausted' };
  }

  // Gate 4 — cheap heuristic: only continue if there's something worth saying.
  const signal = worthSayingSignal(text, context);
  if (signal === null) {
    return { shouldPost: false, reason: 'not_worth_saying' };
  }

  // Gate 5 — optional LLM judge confirms (the only step that may spend tokens).
  // A failing judge fails closed: an unconfirmed post is no post.
  if (judge) {
    let verdict;
    try {
      verdict = await judge({ message, context, heuristic: signal });
    } catch {
      return { shouldPost: false, reason: 'judge_failed' };
    }
    if (!verdict.post) {
      return { shouldPost: false, reason: 'judge_declined' };
    }
    return { shouldPost: true, reason: 'judge_approved' };
  }

  return { shouldPost: true, reason: signal };
}
