import { z } from 'zod';

export const ReplyLanguageSchema = z.enum(['zh-CN', 'en-US']);

export type ReplyLanguage = z.infer<typeof ReplyLanguageSchema>;

export function mapFeishuLocaleToReplyLanguage(locale?: string): ReplyLanguage | undefined {
  if (!locale) return undefined;
  if (locale === 'zh_cn') return 'zh-CN';
  if (locale === 'en_us') return 'en-US';
  return undefined;
}

export function inferReplyLanguageFromText(text?: string): ReplyLanguage | undefined {
  if (!text) return undefined;

  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const hanCount = (trimmed.match(/\p{Script=Han}/gu) ?? []).length;
  const englishWordCount = (trimmed.match(/[A-Za-z]+/g) ?? []).length;

  if (hanCount === 0 && englishWordCount === 0) {
    return undefined;
  }

  if (hanCount === 0) {
    return 'en-US';
  }

  if (englishWordCount === 0) {
    return 'zh-CN';
  }

  return hanCount >= englishWordCount ? 'zh-CN' : 'en-US';
}
