import type { LlmClient } from '@open-tag/llm-client';
import { IntentType, truncateText } from '@open-tag/core-types';

const TRACKING_INTENT_SYSTEM_PROMPT = `You decide whether a Feishu chat message should create or reuse a Feishu Task tracking item.

Return ONLY valid JSON in this shape: {"track": true, "title": "short task title"} or {"track": false}.

Track only when the current message asks the bot to do concrete work with a deliverable, such as:
- create or modify files, code, tests, config, docs, data, or scripts
- implement, fix, debug, refactor, migrate, deploy, run, verify, or investigate something
- research, analyze, compare, summarize, or produce a report

Do NOT track greetings, thanks, acknowledgements, casual chat, pure status questions, or vague messages without a requested deliverable.

Use recent topic messages only to disambiguate the current message. The current message is the decision target.
Keep title concise, in the user's language when practical. Do not wrap JSON in markdown.`;

const DEFAULT_LLM_TIMEOUT_MS = 1500;
const MAX_MESSAGE_CHARS = 1000;
const MAX_RECENT_MESSAGES = 5;
const MAX_TITLE_CHARS = 120;

const WORK_KEYWORD_PATTERNS = [
  /创建|新建|写入|写一个|实现|修复|解决|排查|调试|改造|修改|更新|增加|添加|删除|移除|重构|迁移|部署|运行|执行|测试|验证|生成|整理|总结|分析|调研|调查|研究|对比|评估|查找|搜索|提交/,
  /\b(create|write|implement|fix|solve|debug|investigate|modify|update|add|remove|delete|refactor|migrate|deploy|run|execute|test|verify|generate|organize|summarize|analyze|research|compare|evaluate|find|search|submit)\b/i,
];

const CHAT_ONLY_PATTERNS = [
  /^(你好|您好|hi|hello|hey|在吗|谢谢|感谢|收到|好的|好|ok|okay|辛苦了|明白|了解)[。！!,.，\s]*$/i,
  /^(进度怎么样|状态怎么样|做完了吗|完成了吗|代码都提交了吗)[？?。！!,.，\s]*$/,
];

export interface FeishuTrackingIntentDecision {
  track: boolean;
  title?: string;
  source: 'intent' | 'llm' | 'keyword' | 'none';
}

export interface ClassifyFeishuTrackingIntentInput {
  taskType: IntentType;
  currentMessage: string;
  recentMessages?: string[];
  llmClient?: LlmClient | null;
  timeoutMs?: number;
}

function isDirectlyTrackableIntent(taskType: IntentType): boolean {
  return (
    taskType === IntentType.ANALYSIS ||
    taskType === IntentType.RESEARCH ||
    taskType === IntentType.SELF_IMPROVEMENT ||
    taskType === IntentType.SELF_DEV
  );
}

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.trim();
  if (!title) return undefined;
  return truncateText(title, MAX_TITLE_CHARS, { trimEnd: true });
}

function buildUserPrompt(currentMessage: string, recentMessages: string[]): string {
  const recent = recentMessages
    .filter((message) => message.trim())
    .slice(-MAX_RECENT_MESSAGES)
    .map(
      (message, index) =>
        `${index + 1}. ${truncateText(message.trim(), MAX_MESSAGE_CHARS, { trimEnd: true })}`,
    )
    .join('\n');

  return [
    recent ? `Recent topic user messages:\n${recent}` : 'Recent topic user messages: none',
    '',
    `Current message:\n${truncateText(currentMessage.trim(), MAX_MESSAGE_CHARS, { trimEnd: true })}`,
  ].join('\n');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('LLM tracking intent timed out')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

async function classifyWithLlm(input: {
  currentMessage: string;
  recentMessages: string[];
  llmClient: LlmClient;
  timeoutMs: number;
}): Promise<FeishuTrackingIntentDecision> {
  const response = await withTimeout(
    input.llmClient.chat(
      [
        { role: 'system', content: TRACKING_INTENT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildUserPrompt(input.currentMessage, input.recentMessages),
        },
      ],
      { maxTokens: 80, temperature: 0, timeoutMs: input.timeoutMs },
    ),
    input.timeoutMs,
  );

  const parsed = JSON.parse(response.trim()) as { track?: unknown; title?: unknown };
  if (parsed.track !== true && parsed.track !== false) {
    throw new Error('LLM tracking intent response missing boolean track');
  }

  return {
    track: parsed.track,
    title: parsed.track ? normalizeTitle(parsed.title) : undefined,
    source: 'llm',
  };
}

export function classifyFeishuTrackingIntentByKeywords(input: {
  currentMessage: string;
  recentMessages?: string[];
}): FeishuTrackingIntentDecision {
  const current = input.currentMessage.trim();
  if (!current) return { track: false, source: 'keyword' };
  if (CHAT_ONLY_PATTERNS.some((pattern) => pattern.test(current))) {
    return { track: false, source: 'keyword' };
  }

  const context = [current, ...(input.recentMessages ?? [])].join('\n');
  const track = WORK_KEYWORD_PATTERNS.some((pattern) => pattern.test(context));
  return {
    track,
    title: track ? truncateText(current, MAX_TITLE_CHARS, { trimEnd: true }) : undefined,
    source: 'keyword',
  };
}

export async function classifyFeishuTrackingIntent(
  input: ClassifyFeishuTrackingIntentInput,
): Promise<FeishuTrackingIntentDecision> {
  if (isDirectlyTrackableIntent(input.taskType)) {
    return { track: true, source: 'intent' };
  }

  if (input.taskType !== IntentType.CHAT_REPLY) {
    return { track: false, source: 'none' };
  }

  const currentMessage = input.currentMessage.trim();
  if (!currentMessage) return { track: false, source: 'none' };

  const recentMessages = input.recentMessages ?? [];
  if (input.llmClient) {
    try {
      return await classifyWithLlm({
        currentMessage,
        recentMessages,
        llmClient: input.llmClient,
        timeoutMs: input.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      });
    } catch {
      return classifyFeishuTrackingIntentByKeywords({ currentMessage, recentMessages });
    }
  }

  return classifyFeishuTrackingIntentByKeywords({ currentMessage, recentMessages });
}
