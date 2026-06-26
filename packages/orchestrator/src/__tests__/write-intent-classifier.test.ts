import { describe, it, expect, vi } from 'vitest';
import { classifyWriteIntent } from '../write-intent-classifier.js';
import type { LlmClient } from '@open-tag/llm-client';

function mockLlmClient(response: string | (() => Promise<string>)): LlmClient {
  return {
    chat: typeof response === 'string' ? vi.fn().mockResolvedValue(response) : vi.fn(response),
    provider: () => 'mock',
  };
}

describe('classifyWriteIntent', () => {
  it('returns true when LLM signals a write request', async () => {
    const client = mockLlmClient('{"isWrite": true}');
    expect(await classifyWriteIntent('把错误处理加上 sessionId', client)).toBe(true);
  });

  it('returns false when LLM explicitly signals a readonly request', async () => {
    const client = mockLlmClient('{"isWrite": false}');
    expect(await classifyWriteIntent('解释一下 resolveDevWorkspace', client)).toBe(false);
  });

  it('short-circuits to false for empty/whitespace-only text without calling the LLM', async () => {
    const chat = vi.fn();
    const client: LlmClient = { chat, provider: () => 'mock' };
    expect(await classifyWriteIntent('', client)).toBe(false);
    expect(await classifyWriteIntent('  ', client)).toBe(false);
    expect(await classifyWriteIntent('\n\t', client)).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });

  // Codex review fix: single-character Chinese replies like "改" / "修" are
  // valid escalations advertised by the readonly system prompt; they must
  // reach the LLM rather than being short-circuited as readonly.
  it('does NOT short-circuit single-character escalation replies', async () => {
    const chat = vi.fn().mockResolvedValue('{"isWrite": true}');
    const client: LlmClient = { chat, provider: () => 'mock' };
    expect(await classifyWriteIntent('改', client)).toBe(true);
    expect(chat).toHaveBeenCalledOnce();
  });

  // Codex review fix: when LLM is unavailable, preserve previous write behavior
  // so that deployments without OPEN_TAG_LLM_* configured do not lose the
  // ability to make code changes.
  it('falls back to true (write) when llmClient is null', async () => {
    expect(await classifyWriteIntent('refactor createWorktree to be idempotent', null)).toBe(true);
  });

  it('falls back to true (write) when LLM response is unparseable JSON', async () => {
    const client = mockLlmClient('not json');
    expect(await classifyWriteIntent('refactor createWorktree', client)).toBe(true);
  });

  it('falls back to true (write) when LLM throws', async () => {
    const client = mockLlmClient(async () => {
      throw new Error('timeout');
    });
    expect(await classifyWriteIntent('refactor createWorktree', client)).toBe(true);
  });

  it('falls back to true (write) for unexpected JSON shape', async () => {
    const client = mockLlmClient('{"foo": "bar"}');
    expect(await classifyWriteIntent('something', client)).toBe(true);
  });

  it('falls back to true (write) for non-boolean isWrite values', async () => {
    const client = mockLlmClient('{"isWrite": "true"}');
    expect(await classifyWriteIntent('something long enough', client)).toBe(true);
  });

  it('only treats explicit isWrite:false as readonly', async () => {
    const client = mockLlmClient('{"isWrite": false}');
    expect(await classifyWriteIntent('something long enough', client)).toBe(false);
  });

  // Codex review fix: contextual confirmations like "yes" after the assistant
  // proposed a code change must reach the classifier WITH the prior context
  // so they classify as write rather than ambiguous-→-readonly.
  it('passes recent assistant context into the LLM call when provided', async () => {
    const chat = vi.fn().mockResolvedValue('{"isWrite": true}');
    const client: LlmClient = { chat, provider: () => 'mock' };
    await classifyWriteIntent('yes', client, {
      recentAssistantContext: 'I can refactor createWorktree. Want me to do that?',
    });
    expect(chat).toHaveBeenCalledOnce();
    const messages = chat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const userMessage = messages.find((m) => m.role === 'user')!;
    expect(userMessage.content).toContain('Recent context');
    expect(userMessage.content).toContain('refactor createWorktree');
    expect(userMessage.content).toContain('User\'s new message');
    expect(userMessage.content).toContain('yes');
  });

  it('omits the context block when recentAssistantContext is null/empty', async () => {
    const chat = vi.fn().mockResolvedValue('{"isWrite": true}');
    const client: LlmClient = { chat, provider: () => 'mock' };
    await classifyWriteIntent('refactor X', client, { recentAssistantContext: null });
    const messages = chat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages.find((m) => m.role === 'user')!.content).toBe('refactor X');
  });

  it('truncates very long context to keep prompt size bounded', async () => {
    const chat = vi.fn().mockResolvedValue('{"isWrite": true}');
    const client: LlmClient = { chat, provider: () => 'mock' };
    const huge = 'A'.repeat(5000);
    await classifyWriteIntent('yes', client, { recentAssistantContext: huge });
    const messages = chat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === 'user')!.content;
    // Keep some headroom for prompt scaffolding; the raw context contribution
    // must not exceed the configured cap.
    const aRunMatch = userMsg.match(/A+/g) ?? [];
    const longestRun = aRunMatch.reduce((acc, s) => Math.max(acc, s.length), 0);
    expect(longestRun).toBeLessThanOrEqual(2000);
  });
});
