import type { LlmClient } from '@open-tag/llm-client';

const CLASSIFY_SYSTEM_PROMPT = `You classify whether the user's CURRENT message requests writing/modifying code or just asks a read-only question.

You may see a "Recent context" block describing what the assistant said previously. Use it to disambiguate short replies — a confirmation like "yes" / "go ahead" / "好的" / "可以" right after the assistant proposed a concrete code change is a write request, while the same word after an explanation is read-only.

Return ONLY valid JSON: {"isWrite": true} or {"isWrite": false}.
- true: the user wants files modified, code added/refactored/deleted, bugs fixed, features implemented, or any change applied to a codebase. This includes contextual confirmations of a previously proposed code change.
- false: the user is asking a question, requesting an explanation, analysis, summary, location lookup, or any other read-only inspection. When intent is ambiguous AND there is no contextual write signal, prefer false.

Examples (no context):
User: 解释一下 resolveDevWorkspace 这个函数
Output: {"isWrite": false}

User: 把错误处理加上 sessionId
Output: {"isWrite": true}

User: refactor createWorktree to be idempotent
Output: {"isWrite": true}

User: 在哪定义的
Output: {"isWrite": false}

Examples (with context):
Recent context: I can refactor createWorktree to deduplicate the existing-on-disk check. Want me to do that?
User: yes
Output: {"isWrite": true}

Recent context: Here's how the function works: it checks the DB then disk...
User: yes
Output: {"isWrite": false}

Recent context: I'll add a sessionId field to the log line at line 113.
User: 改
Output: {"isWrite": true}

Do not wrap the JSON in markdown. Do not add any explanation.`;

const MAX_CONTEXT_CHARS = 2000;

export interface ClassifyWriteIntentOptions {
  /**
   * Optional recent assistant message text. When provided, the classifier sees
   * it as "Recent context" and can correctly disambiguate short replies like
   * "yes" / "改" / "go ahead" that confirm a previously proposed code change.
   * Codex review feedback: without this, contextual confirmations were misrouted
   * as readonly and the requested edit never happened.
   */
  recentAssistantContext?: string | null;
}

/**
 * Classify whether the user wants files modified (write) or just answers (readonly).
 *
 * Returns false (readonly) only when the LLM confidently classifies this turn as
 * read-only. Empty text is treated as readonly trivially. Every other case —
 * missing client, network error, unparseable JSON, unexpected shape — falls
 * back to true (write) so deployments without an LLM classifier preserve the
 * prior behavior where every dev request creates a worktree.
 *
 * Note: there is intentionally NO length-based short-circuit. Single-character
 * Chinese replies like "改" / "修" are valid escalations from a prior readonly
 * turn ("reply with `改` to switch to write mode"), so they must reach the LLM.
 */
export async function classifyWriteIntent(
  text: string,
  llmClient: LlmClient | null,
  options?: ClassifyWriteIntentOptions,
): Promise<boolean> {
  if (!text || text.trim().length === 0) return false;
  if (!llmClient) return true;

  const ctx = options?.recentAssistantContext?.trim();
  const userPrompt = ctx
    ? `Recent context (assistant's previous message):\n${ctx.slice(0, MAX_CONTEXT_CHARS)}\n\nUser's new message:\n${text}`
    : text;

  try {
    const response = await llmClient.chat(
      [
        { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { maxTokens: 32, temperature: 0, timeoutMs: 5000 },
    );

    const parsed = JSON.parse(response.trim());
    // Only treat as readonly when the LLM explicitly emits isWrite: false.
    // Any other shape (missing field, non-boolean, malformed) → write.
    return parsed.isWrite !== false;
  } catch {
    return true;
  }
}
