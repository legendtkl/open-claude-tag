import { describe, expect, it } from 'vitest';
import {
  MAX_STORED_RESPONSE_LENGTH,
  selectAssistantHistoryContent,
  selectUserFacingResponseContent,
  truncateAssistantHistoryContent,
} from '../assistant-response-content.js';

describe('assistant response history content', () => {
  it('stores the visible final reply when the runtime output is only a final reply tag', () => {
    expect(
      selectAssistantHistoryContent({
        outputText: '',
        finalReplyText: 'Agent A visible answer from this Feishu topic.',
      }),
    ).toBe('Agent A visible answer from this Feishu topic.');
  });

  it('prefers normal runtime output over a separate final reply', () => {
    expect(
      selectAssistantHistoryContent({
        outputText: 'Detailed result for history.',
        finalReplyText: 'Short card text.',
      }),
    ).toBe('Detailed result for history.');
  });

  it('prefers the explicit final reply for user-facing delivery', () => {
    expect(
      selectUserFacingResponseContent({
        outputText: 'Detailed runtime notes for history.',
        finalReplyText: 'Short visible answer.',
      }),
    ).toBe('Short visible answer.');
  });

  it('truncates long history entries at the storage limit', () => {
    const content = 'x'.repeat(MAX_STORED_RESPONSE_LENGTH + 1);
    const truncated = truncateAssistantHistoryContent(content);

    expect(truncated).toHaveLength(MAX_STORED_RESPONSE_LENGTH + '\n... (truncated)'.length);
    expect(truncated.endsWith('\n... (truncated)')).toBe(true);
  });
});
