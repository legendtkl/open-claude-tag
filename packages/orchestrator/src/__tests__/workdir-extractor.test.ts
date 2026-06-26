import { describe, it, expect, vi } from 'vitest';
import { extractPromptMetadata, extractWorkDir, resolveWorkDir } from '../workdir-extractor.js';
import type { LlmClient } from '@open-tag/llm-client';

function mockLlmClient(response: string): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue(response),
    provider: () => 'mock',
  };
}

describe('extractPromptMetadata', () => {
  it('extracts workDir, goal, and runtime from LLM response', async () => {
    const client = mockLlmClient(
      '{"workDir": "/tmp/project", "goal": "implement search", "runtime": "codex"}',
    );
    const result = await extractPromptMetadata(
      'help me implement search in /tmp/project using codex',
      client,
    );
    expect(result.workDir).toBe('/tmp/project');
    expect(result.goal).toBe('implement search');
    expect(result.runtime).toBe('codex');
  });

  it('normalizes claude aliases to claude_code', async () => {
    const client = mockLlmClient(
      '{"workDir": null, "goal": "review this", "runtime": "Claude Code"}',
    );
    const result = await extractPromptMetadata('use Claude Code to review this', client);
    expect(result.runtime).toBe('claude_code');
  });

  it('returns null runtime when LLM says null', async () => {
    const client = mockLlmClient(
      '{"workDir": null, "goal": "write a sort algorithm", "runtime": null}',
    );
    const result = await extractPromptMetadata('write a sort algorithm', client);
    expect(result.workDir).toBeNull();
    expect(result.goal).toBe('write a sort algorithm');
    expect(result.runtime).toBeNull();
  });

  it('returns null runtime when LLM returns an unknown value', async () => {
    const client = mockLlmClient(
      '{"workDir": null, "goal": "write tests", "runtime": "gpt4"}',
    );
    const result = await extractPromptMetadata('write tests', client);
    expect(result.runtime).toBeNull();
  });

  it('falls back to original text on JSON parse error', async () => {
    const client = mockLlmClient('not valid json');
    const result = await extractPromptMetadata('original text', client);
    expect(result.workDir).toBeNull();
    expect(result.goal).toBe('original text');
    expect(result.runtime).toBeNull();
  });

  it('falls back to original text on LLM error', async () => {
    const client: LlmClient = {
      chat: vi.fn().mockRejectedValue(new Error('timeout')),
      provider: () => 'mock',
    };
    const result = await extractPromptMetadata('original text', client);
    expect(result.workDir).toBeNull();
    expect(result.goal).toBe('original text');
    expect(result.runtime).toBeNull();
  });

  it('extracts relative path', async () => {
    const client = mockLlmClient(
      '{"workDir": "./my-project", "goal": "add feature", "runtime": null}',
    );
    const result = await extractPromptMetadata('add feature in ./my-project', client);
    expect(result.workDir).toBe('./my-project');
    expect(result.goal).toBe('add feature');
  });
});

describe('extractWorkDir', () => {
  it('extracts workDir and goal from LLM response', async () => {
    const client = mockLlmClient(
      '{"workDir": "/tmp/project", "goal": "implement search", "runtime": "codex"}',
    );
    const result = await extractWorkDir('help me implement search in /tmp/project', client);
    expect(result.workDir).toBe('/tmp/project');
    expect(result.goal).toBe('implement search');
  });

  it('returns null workDir when LLM says null', async () => {
    const client = mockLlmClient(
      '{"workDir": null, "goal": "write a sort algorithm", "runtime": null}',
    );
    const result = await extractWorkDir('write a sort algorithm', client);
    expect(result.workDir).toBeNull();
    expect(result.goal).toBe('write a sort algorithm');
  });

  it('returns null workDir when LLM returns "null" string', async () => {
    const client = mockLlmClient(
      '{"workDir": "null", "goal": "write tests", "runtime": null}',
    );
    const result = await extractWorkDir('write tests', client);
    expect(result.workDir).toBeNull();
    expect(result.goal).toBe('write tests');
  });

  it('falls back to original text on JSON parse error', async () => {
    const client = mockLlmClient('not valid json');
    const result = await extractWorkDir('original text', client);
    expect(result.workDir).toBeNull();
    expect(result.goal).toBe('original text');
  });

  it('falls back to original text on LLM error', async () => {
    const client: LlmClient = {
      chat: vi.fn().mockRejectedValue(new Error('timeout')),
      provider: () => 'mock',
    };
    const result = await extractWorkDir('original text', client);
    expect(result.workDir).toBeNull();
    expect(result.goal).toBe('original text');
  });

  it('extracts relative path', async () => {
    const client = mockLlmClient(
      '{"workDir": "./my-project", "goal": "add feature", "runtime": null}',
    );
    const result = await extractWorkDir('add feature in ./my-project', client);
    expect(result.workDir).toBe('./my-project');
    expect(result.goal).toBe('add feature');
  });
});

describe('resolveWorkDir', () => {
  const baseDir = '/repo/root';

  it('returns baseDir when workDir is null', () => {
    expect(resolveWorkDir(null, baseDir)).toBe('/repo/root');
  });

  it('returns absolute path as-is', () => {
    expect(resolveWorkDir('/Users/foo/proj', baseDir)).toBe('/Users/foo/proj');
  });

  it('expands ~ to home directory', () => {
    const result = resolveWorkDir('~/proj', baseDir);
    expect(result).toMatch(/\/proj$/);
    expect(result).not.toContain('~');
  });

  it('resolves relative path against baseDir', () => {
    expect(resolveWorkDir('./my-proj', baseDir)).toBe('/repo/root/my-proj');
  });

  it('resolves bare directory name against baseDir', () => {
    expect(resolveWorkDir('my-proj', baseDir)).toBe('/repo/root/my-proj');
  });

  it('resolves nested relative path', () => {
    expect(resolveWorkDir('a/b/c', baseDir)).toBe('/repo/root/a/b/c');
  });
});
