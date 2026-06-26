import { describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '@open-tag/llm-client';
import { IntentType } from '@open-tag/core-types';
import {
  classifyFeishuTrackingIntent,
  classifyFeishuTrackingIntentByKeywords,
} from '../feishu-tracking-intent.js';

function makeLlm(response: string): LlmClient {
  return {
    chat: vi.fn(async () => response),
    provider: () => 'test',
  };
}

describe('classifyFeishuTrackingIntent', () => {
  it('tracks existing work-bearing intents without calling the LLM', async () => {
    const llmClient = makeLlm('{"track": false}');

    const result = await classifyFeishuTrackingIntent({
      taskType: IntentType.SELF_DEV,
      currentMessage: 'hello',
      llmClient,
    });

    expect(result).toEqual({ track: true, source: 'intent' });
    expect(llmClient.chat).not.toHaveBeenCalled();
  });

  it('uses LLM output to track a chat reply task', async () => {
    const llmClient = makeLlm('{"track": true, "title": "创建 2.txt 并写入 hello world"}');

    const result = await classifyFeishuTrackingIntent({
      taskType: IntentType.CHAT_REPLY,
      currentMessage: '创建一个文件 2.txt，写入内容 hello world',
      recentMessages: ['你好', '你先看看这个项目'],
      llmClient,
    });

    expect(result).toEqual({
      track: true,
      title: '创建 2.txt 并写入 hello world',
      source: 'llm',
    });
    expect(llmClient.chat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Current message:'),
        }),
      ]),
      expect.objectContaining({ timeoutMs: 1500 }),
    );
  });

  it('uses LLM output to skip chat-only turns', async () => {
    const result = await classifyFeishuTrackingIntent({
      taskType: IntentType.CHAT_REPLY,
      currentMessage: '你好',
      llmClient: makeLlm('{"track": false}'),
    });

    expect(result).toEqual({ track: false, source: 'llm' });
  });

  it('falls back to keywords when the LLM throws', async () => {
    const llmClient: LlmClient = {
      chat: vi.fn(async () => {
        throw new Error('llm unavailable');
      }),
      provider: () => 'test',
    };

    const result = await classifyFeishuTrackingIntent({
      taskType: IntentType.CHAT_REPLY,
      currentMessage: '调研一下这两个方案并总结优缺点',
      llmClient,
    });

    expect(result).toEqual({
      track: true,
      title: '调研一下这两个方案并总结优缺点',
      source: 'keyword',
    });
  });

  it('falls back to keywords when the LLM times out', async () => {
    const llmClient: LlmClient = {
      chat: vi.fn(() => new Promise<string>(() => undefined)),
      provider: () => 'test',
    };

    const result = await classifyFeishuTrackingIntent({
      taskType: IntentType.CHAT_REPLY,
      currentMessage: '创建一个文件 2.txt，写入内容 hello world',
      llmClient,
      timeoutMs: 1,
    });

    expect(result.track).toBe(true);
    expect(result.source).toBe('keyword');
  });

  it('falls back to keywords when the LLM returns invalid JSON', async () => {
    const result = await classifyFeishuTrackingIntent({
      taskType: IntentType.CHAT_REPLY,
      currentMessage: 'please implement the retry fix',
      llmClient: makeLlm('not json'),
    });

    expect(result.track).toBe(true);
    expect(result.source).toBe('keyword');
  });

  it('falls back to keywords when no LLM client is configured', async () => {
    const result = await classifyFeishuTrackingIntent({
      taskType: IntentType.CHAT_REPLY,
      currentMessage: '创建一个文件 2.txt，写入内容 hello world',
      llmClient: null,
    });

    expect(result.track).toBe(true);
    expect(result.source).toBe('keyword');
  });

  it('keeps simple status questions untracked in keyword fallback', () => {
    expect(
      classifyFeishuTrackingIntentByKeywords({
        currentMessage: '代码都提交了吗？',
      }),
    ).toEqual({ track: false, source: 'keyword' });
  });
});
