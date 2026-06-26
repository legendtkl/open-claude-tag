import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../token-estimator.js';
import {
  DEFAULT_BUDGET,
  agentSessionMemoryScopeId,
  buildVisibleMemoryScopes,
  filterMessagesVisibleToAgent,
} from '../context-builder.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates English text tokens', () => {
    const text = 'Hello, this is a test message for token estimation';
    const tokens = estimateTokens(text);
    // ~50 chars ASCII → ~12.5 tokens
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(50);
  });

  it('estimates CJK text with higher token count', () => {
    const text = '这是一个中文测试消息';
    const tokens = estimateTokens(text);
    // 9 CJK chars → ~13.5 tokens
    expect(tokens).toBeGreaterThan(10);
  });

  it('handles mixed text', () => {
    const text = 'Hello 你好 World 世界';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(5);
  });
});

describe('DEFAULT_BUDGET', () => {
  it('budget ratios sum to 1.0', () => {
    const sum =
      DEFAULT_BUDGET.systemPromptRatio +
      DEFAULT_BUDGET.memoryRatio +
      DEFAULT_BUDGET.recentTurnsRatio +
      DEFAULT_BUDGET.outputReserveRatio;
    expect(sum).toBe(1.0);
  });

  it('has 15/20/55/10 distribution', () => {
    expect(DEFAULT_BUDGET.systemPromptRatio).toBe(0.15);
    expect(DEFAULT_BUDGET.memoryRatio).toBe(0.2);
    expect(DEFAULT_BUDGET.recentTurnsRatio).toBe(0.55);
    expect(DEFAULT_BUDGET.outputReserveRatio).toBe(0.1);
  });

  it('total budget is 128k', () => {
    expect(DEFAULT_BUDGET.totalBudget).toBe(128000);
  });
});

describe('agent-aware context visibility', () => {
  const turns = [
    { role: 'user', content: 'legacy shared turn', agentId: null },
    { role: 'assistant', content: 'agent a answer', agentId: 'agent_a' },
    { role: 'assistant', content: 'agent b private answer', agentId: 'agent_b' },
  ];

  it('keeps legacy behavior by making all messages visible without agentId', () => {
    expect(filterMessagesVisibleToAgent(turns).map((turn) => turn.content)).toEqual([
      'legacy shared turn',
      'agent a answer',
      'agent b private answer',
    ]);
  });

  it('makes same-session different-agent messages visible', () => {
    expect(filterMessagesVisibleToAgent(turns, 'agent_a').map((turn) => turn.content)).toEqual([
      'legacy shared turn',
      'agent a answer',
      'agent b private answer',
    ]);
  });

  it('includes shared session, agent, and agent-session memory scopes for agent context', () => {
    expect(buildVisibleMemoryScopes('session_1', 'agent_a')).toEqual([
      { scopeType: 'session', scopeId: 'session_1' },
      { scopeType: 'agent', scopeId: 'agent_a' },
      { scopeType: 'agent_session', scopeId: agentSessionMemoryScopeId('agent_a', 'session_1') },
    ]);
  });

  it('keeps legacy memory scope unchanged without agentId', () => {
    expect(buildVisibleMemoryScopes('session_1')).toEqual([
      { scopeType: 'session', scopeId: 'session_1' },
    ]);
  });
});
