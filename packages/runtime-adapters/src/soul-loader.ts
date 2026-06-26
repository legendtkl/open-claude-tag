import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Load soul definition files (SOUL.md + STYLE.md) from the given directory.
 * Returns a concatenated string for use as a system prompt prefix.
 * Silently returns empty string if files are missing or directory doesn't exist.
 *
 * @param soulDir - Path to soul directory. Defaults to SOUL_DIR env var or `<cwd>/soul`.
 */
export function loadSoul(soulDir?: string): string {
  const dir = soulDir ?? process.env.SOUL_DIR ?? join(process.cwd(), 'soul');

  const parts: string[] = [];

  for (const filename of ['SOUL.md', 'STYLE.md']) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      parts.push(readFileSync(filePath, 'utf-8').trim());
    }
  }

  return parts.join('\n\n');
}
