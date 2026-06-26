import { IntentType } from '@open-tag/core-types';

const OPS_COMMANDS = new Set(['/status', '/session', '/compact', '/forget', '/reset', '/help']);

// Keywords include Chinese variants to classify messages typed in Chinese by Feishu users.
const ANALYSIS_KEYWORDS = [
  '分析', // analyze
  '解释', // explain
  '架构', // architecture
  '设计', // design
  '为什么', // why
  '原理', // principle/rationale
  '优化建议', // optimization suggestions
  'analyze',
  'explain',
  'architecture',
  'design',
  'why',
  'review',
  '代码审查', // code review
  '性能', // performance
  'performance',
  'bottleneck',
];

const RESEARCH_KEYWORDS = [
  '查找', // find/lookup
  '搜索', // search
  '总结', // summarize
  '文档', // document
  '调研', // research/investigate
  'search',
  'find',
  'summarize',
  'document',
  'research',
];

const SELF_IMPROVEMENT_KEYWORDS = [
  '优化 prompt', // optimize prompt
  '改进 agent', // improve agent
  '更新配置', // update config
  '自迭代', // self-iterate
  'improve prompt',
  'update agent',
  'self-improve',
];

export function classifyIntent(text: string, command?: string): IntentType {
  // Command-based classification
  if (command) {
    if (command === '/new') return IntentType.OPS_TASK;
    if (OPS_COMMANDS.has(command)) return IntentType.OPS_TASK;
  }

  return classifyFromText(text);
}

function classifyFromText(text: string): IntentType {
  const lower = text.toLowerCase();

  // Check self_improvement first (most specific)
  if (SELF_IMPROVEMENT_KEYWORDS.some((k) => lower.includes(k))) {
    return IntentType.SELF_IMPROVEMENT;
  }

  // Check analysis
  if (ANALYSIS_KEYWORDS.some((k) => lower.includes(k))) {
    return IntentType.ANALYSIS;
  }

  // Check research
  if (RESEARCH_KEYWORDS.some((k) => lower.includes(k))) {
    return IntentType.RESEARCH;
  }

  // Short messages are likely chat
  if (text.length < 20) {
    return IntentType.CHAT_REPLY;
  }

  // Default to chat for ambiguous input
  return IntentType.CHAT_REPLY;
}

export function selectRuntime(_intent: IntentType): string {
  // No explicit per-message choice exists — return 'auto' so that the session's
  // persisted runtimeBackend is preserved by the downstream switch-detection
  // logic. The worker resolves 'auto' to the agent/profile defaultRuntime or
  // the DEFAULT_RUNTIME (claude_code) when no session runtime exists.
  // Intent-specific routing can be added here later.
  return 'auto';
}
