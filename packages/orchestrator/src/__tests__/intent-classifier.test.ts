import { describe, it, expect } from 'vitest';
import { IntentType } from '@open-tag/core-types';
import { classifyIntent, selectRuntime } from '../intent-classifier.js';

describe('classifyIntent', () => {
  it('classifies /status as ops_task', () => {
    expect(classifyIntent('', '/status')).toBe(IntentType.OPS_TASK);
  });

  it('classifies /session as ops_task', () => {
    expect(classifyIntent('list', '/session')).toBe(IntentType.OPS_TASK);
  });

  it('classifies /new as ops_task', () => {
    expect(classifyIntent('', '/new')).toBe(IntentType.OPS_TASK);
  });

  it('classifies "帮我写一个函数" as chat_reply', () => {
    expect(classifyIntent('帮我写一个排序函数')).toBe(IntentType.CHAT_REPLY);
  });

  it('classifies "implement a feature" as chat_reply', () => {
    expect(classifyIntent('implement a fibonacci function')).toBe(IntentType.CHAT_REPLY);
  });

  it('classifies "分析架构" as analysis', () => {
    expect(classifyIntent('分析这个仓库的整体架构')).toBe(IntentType.ANALYSIS);
  });

  it('classifies "explain why" as analysis', () => {
    expect(classifyIntent('explain why this function is slow')).toBe(IntentType.ANALYSIS);
  });

  it('classifies "搜索文档" as research', () => {
    expect(classifyIntent('搜索相关文档并总结')).toBe(IntentType.RESEARCH);
  });

  it('classifies "优化 prompt" as self_improvement', () => {
    expect(classifyIntent('优化 prompt 的系统提示')).toBe(IntentType.SELF_IMPROVEMENT);
  });

  it('classifies "你好" as chat_reply', () => {
    expect(classifyIntent('你好')).toBe(IntentType.CHAT_REPLY);
  });

  it('classifies short greetings as chat_reply', () => {
    expect(classifyIntent('hello')).toBe(IntentType.CHAT_REPLY);
  });

  it('unregistered command falls through to text classification', () => {
    expect(classifyIntent('写一个排序函数', '/unknown')).toBe(IntentType.CHAT_REPLY);
  });

  it('/help → OPS_TASK', () => {
    expect(classifyIntent('', '/help')).toBe(IntentType.OPS_TASK);
  });

  it('classifies "代码都提交了吗" as chat_reply', () => {
    expect(classifyIntent('代码都提交了吗？没有看到 CLAUDE.md 的改动提交')).toBe(
      IntentType.CHAT_REPLY,
    );
  });

  it('classifies "帮我写代码" as chat_reply', () => {
    expect(classifyIntent('帮我写代码')).toBe(IntentType.CHAT_REPLY);
  });

  it('analysis questions are still classified as analysis', () => {
    expect(classifyIntent('为什么这段代码会崩溃？')).toBe(IntentType.ANALYSIS);
  });
});

describe('selectRuntime', () => {
  it('analysis → auto (no explicit runtime = preserve session runtime)', () => {
    expect(selectRuntime(IntentType.ANALYSIS)).toBe('auto');
  });

  it('research → auto', () => {
    expect(selectRuntime(IntentType.RESEARCH)).toBe('auto');
  });

  it('self_improvement → auto', () => {
    expect(selectRuntime(IntentType.SELF_IMPROVEMENT)).toBe('auto');
  });

  it('chat_reply → auto', () => {
    expect(selectRuntime(IntentType.CHAT_REPLY)).toBe('auto');
  });

  it('ops_task → auto', () => {
    expect(selectRuntime(IntentType.OPS_TASK)).toBe('auto');
  });

  it('self_dev → auto (inherits session runtime)', () => {
    expect(selectRuntime(IntentType.SELF_DEV)).toBe('auto');
  });
});
