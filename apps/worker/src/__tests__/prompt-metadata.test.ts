import { describe, expect, it, vi } from 'vitest';
import {
  decidePromptMetadataConfirmation,
  decideStickyAdhocWorkDirFallback,
  maybeExtractPromptMetadata,
  resolveTaskRuntime,
  shouldSkipPromptMetadataExtraction,
} from '../prompt-metadata.js';

describe('resolveTaskRuntime', () => {
  it('prefers confirmed runtime over all other inputs', () => {
    expect(resolveTaskRuntime('claude_code', 'claude_code', 'codex')).toBe('codex');
  });

  it('prefers session runtime backend over auto runtime hint', () => {
    expect(resolveTaskRuntime('auto', 'codex')).toBe('codex');
  });

  it('uses explicit runtime hint when there is no session runtime', () => {
    expect(resolveTaskRuntime('codex', null)).toBe('codex');
  });

  it('falls back to claude_code when no runtime is available', () => {
    expect(resolveTaskRuntime('auto', null)).toBe('claude_code');
  });
});

describe('decidePromptMetadataConfirmation', () => {
  it('requires confirmation for runtime-only changes', () => {
    const decision = decidePromptMetadataConfirmation({
      effectiveGoal: 'compare nvidia datacenter cards',
      resolvedWorkDir: null,
      extractedRuntime: 'codex',
      existingAdhocWorkDir: null,
      currentRuntime: 'claude_code',
    });

    expect(decision.needsConfirmation).toBe(true);
    expect(decision.displayWorkDir).toBeUndefined();
    expect(decision.defaultRuntime).toBe('codex');
    expect(decision.confirmedRuntime).toBe('codex');
  });

  it('reuses sticky passthrough metadata when extraction matches current context', () => {
    const decision = decidePromptMetadataConfirmation({
      effectiveGoal: 'continue the task',
      resolvedWorkDir: null,
      extractedRuntime: null,
      existingAdhocWorkDir: '/tmp/project',
      currentRuntime: 'codex',
    });

    expect(decision.needsConfirmation).toBe(false);
    expect(decision.displayWorkDir).toBe('/tmp/project');
    expect(decision.confirmedWorkDir).toBe('/tmp/project');
    expect(decision.confirmedRuntime).toBe('codex');
  });

  it('requires confirmation when extracted workDir changes', () => {
    const decision = decidePromptMetadataConfirmation({
      effectiveGoal: 'fix the bug',
      resolvedWorkDir: '/tmp/new-project',
      extractedRuntime: null,
      existingAdhocWorkDir: '/tmp/old-project',
      currentRuntime: 'claude_code',
    });

    expect(decision.needsConfirmation).toBe(true);
    expect(decision.displayWorkDir).toBe('/tmp/new-project');
    expect(decision.confirmedWorkDir).toBe('/tmp/new-project');
  });
});

describe('shouldSkipPromptMetadataExtraction', () => {
  it('skips extraction for self-dev tasks', () => {
    expect(shouldSkipPromptMetadataExtraction('self_dev', {})).toBe(true);
  });

  it('allows extraction for plain chat tasks', () => {
    expect(shouldSkipPromptMetadataExtraction('chat_reply', {})).toBe(false);
  });
});

describe('decideStickyAdhocWorkDirFallback', () => {
  it('returns the seeded workdir when extraction is unavailable for a regular task', () => {
    expect(decideStickyAdhocWorkDirFallback('chat_reply', {}, '/tmp/seeded')).toBe('/tmp/seeded');
  });

  it('returns null when no seeded workdir is set', () => {
    expect(decideStickyAdhocWorkDirFallback('chat_reply', {}, null)).toBeNull();
    expect(decideStickyAdhocWorkDirFallback('chat_reply', {}, undefined)).toBeNull();
    expect(decideStickyAdhocWorkDirFallback('chat_reply', {}, '')).toBeNull();
  });

  it('does not apply the seeded workdir to self_dev tasks', () => {
    expect(decideStickyAdhocWorkDirFallback('self_dev', {}, '/tmp/seeded')).toBeNull();
  });

});

describe('maybeExtractPromptMetadata', () => {
  const llmClient = {
    chat: async () => '{"workDir": null, "goal": "noop", "runtime": null}',
    provider: () => 'mock',
  };

  it('does not call the extractor for self-dev tasks', async () => {
    const extractor = vi.fn();

    const result = await maybeExtractPromptMetadata({
      taskType: 'self_dev',
      constraints: {},
      goal: '现在 claude code runtime 启动增加 env ANTHROPIC_API_KEY',
      llmClient,
      extractor,
    });

    expect(result).toBeNull();
    expect(extractor).not.toHaveBeenCalled();
  });

  it('calls the extractor for plain chat tasks', async () => {
    const extraction = {
      workDir: null,
      goal: 'compare runtime docs',
      runtime: 'claude_code' as const,
    };
    const extractor = vi.fn().mockResolvedValue(extraction);

    const result = await maybeExtractPromptMetadata({
      taskType: 'chat_reply',
      constraints: {},
      goal: 'compare runtime docs',
      llmClient,
      extractor,
    });

    expect(result).toEqual(extraction);
    expect(extractor).toHaveBeenCalledOnce();
    expect(extractor).toHaveBeenCalledWith('compare runtime docs', llmClient);
  });

  it('calls the extractor for /use slash-origin tasks', async () => {
    const extraction = {
      workDir: '/tmp/repo',
      goal: 'fix login',
      runtime: 'codex' as const,
    };
    const extractor = vi.fn().mockResolvedValue(extraction);

    const result = await maybeExtractPromptMetadata({
      taskType: 'chat_reply',
      constraints: { sourceCommand: '/use' },
      goal: 'in /tmp/repo fix login',
      llmClient,
      extractor,
    });

    expect(result).toEqual(extraction);
    expect(extractor).toHaveBeenCalledOnce();
    expect(extractor).toHaveBeenCalledWith('in /tmp/repo fix login', llmClient);
  });
});
