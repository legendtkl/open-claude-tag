import type { LlmClient } from '@open-tag/llm-client';
import type { PromptMetadataExtraction, RuntimeName } from '@open-tag/orchestrator';
import { getRuntimeDescriptor } from '@open-tag/runtime-adapters';

export interface PromptMetadataDecisionInput {
  effectiveGoal: string;
  resolvedWorkDir: string | null;
  extractedRuntime: RuntimeName | null;
  existingAdhocWorkDir: string | null | undefined;
  currentRuntime: RuntimeName;
}

export interface PromptMetadataDecision {
  effectiveGoal: string;
  displayWorkDir?: string;
  defaultRuntime: RuntimeName;
  needsConfirmation: boolean;
  confirmedWorkDir?: string;
  confirmedRuntime: RuntimeName;
}

// Validate against the data-driven runtime registry (the `name()` keys) rather
// than a hardcoded literal list, so a runtime added to the registry is accepted
// as a hint/backend/default with no change here. The persisted `name()` keys
// (`claude_code` underscore, `codex`) ARE the registry keys, so this is
// behavior-equivalent to the previous explicit set.
function isRuntimeName(value: string | null | undefined): value is RuntimeName {
  return value != null && getRuntimeDescriptor(value) !== undefined;
}

function resolveDefaultRuntime(): RuntimeName {
  const configured = process.env.OPEN_TAG_DEFAULT_RUNTIME;
  if (isRuntimeName(configured)) return configured;
  return 'claude_code';
}

/**
 * Where the resolved runtime came from. This drives fail-fast vs logged-fallback
 * behavior downstream: `confirmed` / `explicit_hint` are EXPLICIT user choices
 * (must fail fast when unavailable), while `session_resume` / `agent_default` /
 * `global_default` are auto/default selections (may fall back, but the switch is
 * logged + persisted). It does NOT change which runtime wins — only how an
 * unavailable runtime is handled.
 */
export type RuntimeSelectionSource =
  | 'confirmed'
  | 'explicit_hint'
  | 'session_resume'
  | 'agent_default'
  | 'global_default';

export interface RuntimeSelection {
  runtime: RuntimeName;
  source: RuntimeSelectionSource;
}

export interface RuntimeSelectionInput {
  /** User-confirmed runtime for this turn (highest precedence). */
  confirmedRuntime?: string | null;
  /** Runtime backend carried from the previous turn (session resume). */
  runtimeBackend?: string | null;
  /** Raw per-message runtime hint; `null`/`'auto'` means no explicit choice. */
  runtimeHint?: string | null;
  /** Acting agent's default runtime, used only when no explicit hint is given. */
  agentDefaultRuntime?: string | null;
}

/** `true` when the runtime was selected by an explicit user action this turn. */
export function isExplicitRuntimeSource(source: RuntimeSelectionSource): boolean {
  return source === 'confirmed' || source === 'explicit_hint';
}

/**
 * Resolve the task runtime AND report its selection source. Precedence mirrors
 * {@link resolveTaskRuntime} exactly (confirmed → session resume → explicit hint
 * → agent default → global default), and reproduces the worker's historical
 * behavior that the agent default is consulted ONLY when the raw hint is
 * absent/`auto` — an explicitly provided but unknown hint still falls through to
 * the global default rather than the agent default.
 */
export function resolveTaskRuntimeWithSource(input: RuntimeSelectionInput): RuntimeSelection {
  const { confirmedRuntime, runtimeBackend, runtimeHint, agentDefaultRuntime } = input;

  if (isRuntimeName(confirmedRuntime)) return { runtime: confirmedRuntime, source: 'confirmed' };
  if (isRuntimeName(runtimeBackend)) return { runtime: runtimeBackend, source: 'session_resume' };

  const hintIsAuto = runtimeHint == null || runtimeHint === 'auto';
  if (!hintIsAuto) {
    // An explicit hint was provided this turn. If it names a known runtime use
    // it; if it is unknown, do NOT silently substitute the agent default —
    // fall through to the global default (matches the prior worker behavior).
    if (isRuntimeName(runtimeHint)) return { runtime: runtimeHint, source: 'explicit_hint' };
    return { runtime: resolveDefaultRuntime(), source: 'global_default' };
  }

  // No explicit hint: consider the acting agent's default before the global one.
  if (isRuntimeName(agentDefaultRuntime)) {
    return { runtime: agentDefaultRuntime, source: 'agent_default' };
  }
  return { runtime: resolveDefaultRuntime(), source: 'global_default' };
}

export function resolveTaskRuntime(
  runtimeHint: string | null | undefined,
  runtimeBackend: string | null | undefined,
  confirmedRuntime?: string | null,
): RuntimeName {
  // Reimplemented on top of the source-aware resolver with no agent default, so
  // it stays value-equivalent for existing callers/tests.
  return resolveTaskRuntimeWithSource({ confirmedRuntime, runtimeBackend, runtimeHint }).runtime;
}

export function shouldSkipPromptMetadataExtraction(
  taskType: string,
  _constraints: Record<string, unknown>,
): boolean {
  return taskType === 'self_dev';
}

export async function maybeExtractPromptMetadata(params: {
  taskType: string;
  constraints: Record<string, unknown>;
  goal: string;
  llmClient: LlmClient | null;
  extractor: (text: string, llmClient: LlmClient) => Promise<PromptMetadataExtraction>;
}): Promise<PromptMetadataExtraction | null> {
  const { taskType, constraints, goal, llmClient, extractor } = params;

  if (!llmClient) return null;
  if (shouldSkipPromptMetadataExtraction(taskType, constraints)) return null;

  return extractor(goal, llmClient);
}

/**
 * Fallback for when the LLM extractor is unavailable but the session already
 * carries a seeded `adhocWorkDir` (e.g. from `OPEN_TAG_DEFAULT_WORKDIR`).
 * Returns the workdir to apply directly, or null when the task should not
 * inherit it (self_dev, or the session has no seeded value).
 */
export function decideStickyAdhocWorkDirFallback(
  taskType: string,
  constraints: Record<string, unknown>,
  existingAdhocWorkDir: string | null | undefined,
): string | null {
  if (!existingAdhocWorkDir) return null;
  if (shouldSkipPromptMetadataExtraction(taskType, constraints)) return null;
  return existingAdhocWorkDir;
}

export function decidePromptMetadataConfirmation(
  input: PromptMetadataDecisionInput,
): PromptMetadataDecision {
  const {
    effectiveGoal,
    resolvedWorkDir,
    extractedRuntime,
    existingAdhocWorkDir,
    currentRuntime,
  } = input;

  const workDirChanged =
    resolvedWorkDir !== null && resolvedWorkDir !== (existingAdhocWorkDir ?? null);
  const runtimeChanged = extractedRuntime !== null && extractedRuntime !== currentRuntime;

  const displayWorkDir = resolvedWorkDir ?? existingAdhocWorkDir ?? undefined;
  const confirmedWorkDir = resolvedWorkDir ?? existingAdhocWorkDir ?? undefined;
  const confirmedRuntime = extractedRuntime ?? currentRuntime;

  return {
    effectiveGoal,
    ...(displayWorkDir ? { displayWorkDir } : {}),
    defaultRuntime: confirmedRuntime,
    needsConfirmation: workDirChanged || runtimeChanged,
    ...(confirmedWorkDir ? { confirmedWorkDir } : {}),
    confirmedRuntime,
  };
}
