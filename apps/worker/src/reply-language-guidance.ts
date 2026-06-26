import type { ReplyLanguage } from '@open-tag/core-types';

const ENGINEERING_ARTIFACT_RULE =
  'Keep code, shell commands, file paths, PR text, and GitHub comments in English unless the user explicitly asks otherwise.';

export function extractReplyLanguageFromConstraints(constraints: unknown): ReplyLanguage | undefined {
  if (typeof constraints !== 'object' || constraints === null) {
    return undefined;
  }

  const value = (constraints as Record<string, unknown>).replyLanguage;
  return value === 'zh-CN' || value === 'en-US' ? value : undefined;
}

export function buildReplyLanguageGuidance(replyLanguage?: ReplyLanguage): string | undefined {
  if (!replyLanguage) {
    return undefined;
  }

  const languageName = replyLanguage === 'zh-CN' ? 'Chinese' : 'English';
  return `For Feishu-facing output, respond to the user in ${languageName} by default. ${ENGINEERING_ARTIFACT_RULE}`;
}

export function appendReplyLanguageGuidance(
  basePrompt: string | undefined,
  replyLanguage?: ReplyLanguage,
): string | undefined {
  const guidance = buildReplyLanguageGuidance(replyLanguage);
  if (!guidance) {
    return basePrompt;
  }

  return basePrompt ? `${basePrompt}\n\n${guidance}` : guidance;
}
