import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@open-tag/storage';
import {
  extractReplyLanguageFromMessageMetadata,
  getLatestUserReplyLanguage,
  resolvePreferredReplyLanguage,
} from '../reply-language.js';

function makeDb(rows: unknown[]): Database {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  } as unknown as Database;
}

describe('extractReplyLanguageFromMessageMetadata', () => {
  it('returns reply language when metadata contains a supported value', () => {
    expect(extractReplyLanguageFromMessageMetadata({ replyLanguage: 'zh-CN' })).toBe('zh-CN');
    expect(extractReplyLanguageFromMessageMetadata({ replyLanguage: 'en-US' })).toBe('en-US');
  });

  it('returns undefined for unsupported or missing values', () => {
    expect(extractReplyLanguageFromMessageMetadata({ replyLanguage: 'fr-FR' })).toBeUndefined();
    expect(extractReplyLanguageFromMessageMetadata({})).toBeUndefined();
    expect(extractReplyLanguageFromMessageMetadata(null)).toBeUndefined();
  });
});

describe('getLatestUserReplyLanguage', () => {
  it('returns the latest stored user reply language from message metadata', async () => {
    const db = makeDb([{ metadata: { replyLanguage: 'zh-CN' } }]);

    await expect(getLatestUserReplyLanguage(db, 'session-1')).resolves.toBe('zh-CN');
  });

  it('returns undefined when there is no stored reply language', async () => {
    const db = makeDb([{ metadata: {} }]);

    await expect(getLatestUserReplyLanguage(db, 'session-1')).resolves.toBeUndefined();
  });

  it('skips the latest user message when it has no reply language metadata', async () => {
    const db = makeDb([{ metadata: {} }, { metadata: { replyLanguage: 'zh-CN' } }]);

    await expect(getLatestUserReplyLanguage(db, 'session-1')).resolves.toBe('zh-CN');
  });

  it('caps the fallback lookup to a bounded number of recent messages', async () => {
    const limit = vi.fn().mockResolvedValue([{ metadata: { replyLanguage: 'en-US' } }]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy,
          }),
        }),
      }),
    } as unknown as Database;

    await expect(getLatestUserReplyLanguage(db, 'session-1')).resolves.toBe('en-US');
    expect(limit).toHaveBeenCalledWith(50);
  });
});

describe('resolvePreferredReplyLanguage', () => {
  it('prefers the current message language over session fallback', async () => {
    const db = makeDb([{ metadata: { replyLanguage: 'zh-CN' } }]);

    await expect(resolvePreferredReplyLanguage(db, 'session-1', 'en-US')).resolves.toBe('en-US');
  });

  it('falls back to the latest session user language when current language is missing', async () => {
    const db = makeDb([{ metadata: { replyLanguage: 'zh-CN' } }]);

    await expect(resolvePreferredReplyLanguage(db, 'session-1')).resolves.toBe('zh-CN');
  });

  it('defaults to en-US when neither current nor session language is available', async () => {
    const db = makeDb([]);

    await expect(resolvePreferredReplyLanguage(db, 'session-1')).resolves.toBe('en-US');
  });
});
