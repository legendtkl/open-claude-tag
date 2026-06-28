import { loadWorkflow } from '../workflow-loader.js';

const SELF_DEV_COMMON_PROMPT = loadWorkflow('self-dev-common');
const SELF_DEV_CLAUDE_PROMPT = loadWorkflow('self-dev-claude');
const SELF_DEV_CODEX_PROMPT = loadWorkflow('self-dev-codex');

export function getSelfDevSystemPrompt(runtime: string): string {
  const runtimeSpecificPrompt = runtime === 'codex' ? SELF_DEV_CODEX_PROMPT : SELF_DEV_CLAUDE_PROMPT;
  return `${SELF_DEV_COMMON_PROMPT}\n\n---\n\n${runtimeSpecificPrompt}`;
}

export const SELF_DEV_SYSTEM_PROMPT = getSelfDevSystemPrompt('claude_code');
