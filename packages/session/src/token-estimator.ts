// Simple token estimation: ~4 characters per token for English,
// ~2 characters per token for CJK. We use a rough average.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Count CJK characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}]/gu) ?? []).length;
  const nonCjkLength = text.length - cjkCount;
  // CJK: ~1.5 tokens per character, ASCII: ~0.25 tokens per character
  return Math.ceil(cjkCount * 1.5 + nonCjkLength * 0.25);
}
