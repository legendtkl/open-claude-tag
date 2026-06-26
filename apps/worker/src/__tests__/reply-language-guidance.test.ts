import { describe, expect, it } from 'vitest';
import {
  appendReplyLanguageGuidance,
  buildReplyLanguageGuidance,
  extractReplyLanguageFromConstraints,
} from '../reply-language-guidance.js';

describe('extractReplyLanguageFromConstraints', () => {
  it('returns a supported replyLanguage from task constraints', () => {
    expect(extractReplyLanguageFromConstraints({ replyLanguage: 'zh-CN' })).toBe('zh-CN');
    expect(extractReplyLanguageFromConstraints({ replyLanguage: 'en-US' })).toBe('en-US');
  });

  it('returns undefined for missing or unsupported replyLanguage values', () => {
    expect(extractReplyLanguageFromConstraints({})).toBeUndefined();
    expect(extractReplyLanguageFromConstraints({ replyLanguage: 'fr-FR' })).toBeUndefined();
    expect(extractReplyLanguageFromConstraints(null)).toBeUndefined();
  });
});

describe('buildReplyLanguageGuidance', () => {
  it('builds Chinese reply guidance while keeping engineering artifacts in English', () => {
    const guidance = buildReplyLanguageGuidance('zh-CN');

    expect(guidance).toContain('respond to the user in Chinese');
    expect(guidance).toContain('PR text');
    expect(guidance).toContain('GitHub comments');
  });

  it('builds English reply guidance while keeping engineering artifacts in English', () => {
    const guidance = buildReplyLanguageGuidance('en-US');

    expect(guidance).toContain('respond to the user in English');
    expect(guidance).toContain('GitHub comments');
  });

  it('returns undefined when no reply language is provided', () => {
    expect(buildReplyLanguageGuidance()).toBeUndefined();
  });
});

describe('appendReplyLanguageGuidance', () => {
  it('appends reply guidance to an existing system prompt', () => {
    const prompt = appendReplyLanguageGuidance('Base prompt', 'zh-CN');

    expect(prompt).toContain('Base prompt');
    expect(prompt).toContain('respond to the user in Chinese');
  });

  it('returns only the guidance when there is no base prompt', () => {
    const prompt = appendReplyLanguageGuidance(undefined, 'en-US');

    expect(prompt).toContain('respond to the user in English');
  });

  it('leaves the base prompt unchanged when reply language is missing', () => {
    expect(appendReplyLanguageGuidance('Base prompt')).toBe('Base prompt');
  });
});
