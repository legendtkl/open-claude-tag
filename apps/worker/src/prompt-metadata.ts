import type { LlmClient } from '@open-tag/llm-client';
import type { PromptMetadataExtraction, RuntimeName } from '@open-tag/orchestrator';

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

function isRuntimeName(value: string | null | undefined): value is RuntimeName {
  return value === 'claude_code' || value === 'codex' || value === 'coco';
}

function resolveDefaultRuntime(): RuntimeName {
  const configured = process.env.OPEN_TAG_DEFAULT_RUNTIME;
  if (isRuntimeName(configured)) return configured;
  return 'claude_code';
}

export function resolveTaskRuntime(
  runtimeHint: string | null | undefined,
  runtimeBackend: string | null | undefined,
  confirmedRuntime?: string | null,
): RuntimeName {
  if (isRuntimeName(confirmedRuntime)) return confirmedRuntime;
  if (isRuntimeName(runtimeBackend)) return runtimeBackend;
  if (isRuntimeName(runtimeHint)) return runtimeHint;
  return resolveDefaultRuntime();
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
