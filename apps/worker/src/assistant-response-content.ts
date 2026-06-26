export const MAX_STORED_RESPONSE_LENGTH = 8000;

export function selectAssistantHistoryContent(input: {
  outputText: string;
  finalReplyText?: string;
}): string {
  const outputText = input.outputText.trim();
  if (outputText) return input.outputText;
  return input.finalReplyText?.trim() ? input.finalReplyText : '';
}

export function selectUserFacingResponseContent(input: {
  outputText: string;
  finalReplyText?: string;
}): string {
  const finalReplyText = input.finalReplyText?.trim();
  if (finalReplyText) return input.finalReplyText!;
  const outputText = input.outputText.trim();
  return outputText ? input.outputText : '';
}

export function truncateAssistantHistoryContent(content: string): string {
  return content.length > MAX_STORED_RESPONSE_LENGTH
    ? content.slice(0, MAX_STORED_RESPONSE_LENGTH) + '\n... (truncated)'
    : content;
}
