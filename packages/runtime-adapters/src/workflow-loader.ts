import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// workflows/ lives next to src/ and dist/ under the package root
const WORKFLOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');

/**
 * Load a workflow definition from a markdown file.
 * Workflows live in packages/runtime-adapters/workflows/<name>.md.
 * Add new workflows by dropping a .md file in that directory.
 */
export function loadWorkflow(name: string): string {
  const filePath = join(WORKFLOWS_DIR, `${name}.md`);
  return readFileSync(filePath, 'utf-8');
}
