import type { LlmClient } from '@open-tag/llm-client';
import { resolve } from 'path';
import { homedir } from 'os';

export type RuntimeName = 'claude_code' | 'codex';

export interface WorkDirExtraction {
  /** Absolute or relative path, null if not detected */
  workDir: string | null;
  /** The actual task description (without workDir-related text) */
  goal: string;
}

export interface PromptMetadataExtraction extends WorkDirExtraction {
  /** Requested runtime backend, null if not explicitly specified */
  runtime: RuntimeName | null;
}

const EXTRACTION_SYSTEM_PROMPT = `You extract structured information from user messages.
From the user message, extract:
1. workDir: the working directory / project path the user specified (absolute or relative path). Return null if none specified.
2. goal: the actual task description (without the working directory or runtime-control related text).
3. runtime: the runtime backend the user explicitly wants this system to use. Return only "codex", "claude_code", or null.

Rules for runtime:
- Only set runtime when the user is explicitly choosing the execution backend for this task.
- Normalize Claude aliases such as "claude", "claude code", and "claudecode" to "claude_code".
- If the text merely mentions Codex or Claude as the subject of the task, not as an execution request, return null.
- If unclear, return null.

Return ONLY valid JSON: {"workDir": "path or null", "goal": "task description", "runtime": "codex | claude_code | null"}
Do not wrap in markdown code blocks. Do not add any explanation.`;

function normalizeRuntime(value: unknown): RuntimeName | null {
  if (typeof value !== 'string') return null;

  const normalized = value.toLowerCase().replace(/\s+/g, '');
  if (normalized === 'codex') return 'codex';
  if (normalized === 'claude' || normalized === 'claudecode' || normalized === 'claude_code') {
    return 'claude_code';
  }

  return null;
}

/**
 * Use LLM to semantically extract goal, workDir, and runtime from user text.
 * Returns null metadata values and the original text when extraction fails.
 */
export async function extractPromptMetadata(
  text: string,
  llmClient: LlmClient,
): Promise<PromptMetadataExtraction> {
  try {
    const response = await llmClient.chat(
      [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      { maxTokens: 256, temperature: 0, timeoutMs: 8000 },
    );

    const parsed = JSON.parse(response.trim());

    const workDir =
      parsed.workDir && typeof parsed.workDir === 'string' && parsed.workDir !== 'null'
        ? parsed.workDir
        : null;
    const goal = parsed.goal && typeof parsed.goal === 'string' ? parsed.goal : text;
    const runtime = normalizeRuntime(parsed.runtime);

    return { workDir, goal, runtime };
  } catch {
    return { workDir: null, goal: text, runtime: null };
  }
}

/**
 * Use LLM to semantically extract workDir and goal from user text.
 * Returns { workDir: null, goal: originalText } when extraction fails or no workDir detected.
 */
export async function extractWorkDir(
  text: string,
  llmClient: LlmClient,
): Promise<WorkDirExtraction> {
  const { workDir, goal } = await extractPromptMetadata(text, llmClient);
  return { workDir, goal };
}

/**
 * Resolve workDir to an absolute path.
 * - Absolute path → returned as-is
 * - ~ prefix → expanded to home directory
 * - Relative path → resolved against baseDir
 * - null → returns baseDir itself
 */
export function resolveWorkDir(
  workDir: string | null,
  baseDir: string,
): string {
  if (!workDir) return baseDir;

  // Expand ~ to home directory
  if (workDir.startsWith('~/') || workDir === '~') {
    return resolve(homedir(), workDir.slice(2) || '.');
  }

  // Already absolute
  if (workDir.startsWith('/')) return resolve(workDir);

  // Relative path (including ./ and bare names)
  return resolve(baseDir, workDir);
}
