/**
 * Escape characters Feishu would otherwise interpret when rendering card/post
 * text, so user-supplied content (e.g. an `@name`) is shown literally rather
 * than parsed as markup or a mention.
 */
export function escapeAtText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
