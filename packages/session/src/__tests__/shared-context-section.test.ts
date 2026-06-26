import { describe, it, expect } from 'vitest';
import { buildSharedContextSection } from '../context-builder.js';

describe('buildSharedContextSection', () => {
  it('renders a verified shared-context section when entries are provided', () => {
    const section = buildSharedContextSection([
      { memoryType: 'fact', gist: 'lambdify lacks trailing comma', authorAgentKind: 'claude_code' },
      { memoryType: 'decision', gist: 'keep the M2M constraint explicit', authorAgentKind: 'codex' },
    ]);
    expect(section).toContain('## Shared Context (verified)');
    expect(section).toContain('- [fact] (claude_code) lambdify lacks trailing comma');
    expect(section).toContain('- [decision] (codex) keep the M2M constraint explicit');
  });

  it('omits the author kind annotation when absent', () => {
    const section = buildSharedContextSection([{ memoryType: 'fact', gist: 'g' }]);
    expect(section).toContain('- [fact] g');
    expect(section).not.toContain('()');
  });

  it('returns empty string for undefined or empty input (assembly unchanged)', () => {
    expect(buildSharedContextSection(undefined)).toBe('');
    expect(buildSharedContextSection([])).toBe('');
  });
});
