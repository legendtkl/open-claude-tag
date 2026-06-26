import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';

const pullRequestTemplatePath = new URL(
  '../../../../.github/pull_request_template.md',
  import.meta.url,
);
const prGuidelinesPath = new URL(
  '../../../../doc/contributing/pr-guidelines.md',
  import.meta.url,
);
const copilotInstructionsPath = new URL(
  '../../../../.github/copilot-instructions.md',
  import.meta.url,
);

function normalizeMarkdown(content: string): string {
  return content.replaceAll('\r\n', '\n').trim();
}

function extractPrTemplate(guidelines: string): string {
  const normalizedGuidelines = normalizeMarkdown(guidelines);
  const match = normalizedGuidelines.match(/## PR Body Template\s+```markdown\n([\s\S]*?)```/);

  if (!match) {
    throw new Error('Failed to extract the PR body template from pr-guidelines.md');
  }

  return normalizeMarkdown(match[1]);
}

describe('GitHub repository metadata', () => {
  it('extracts the documented PR template from CRLF-formatted guidelines', () => {
    const guidelines = [
      '# PR Guidelines',
      '',
      '## PR Body Template',
      '',
      '```markdown',
      '## Goal',
      '',
      'Template body',
      '```',
    ].join('\r\n');

    expect(extractPrTemplate(guidelines)).toBe(['## Goal', '', 'Template body'].join('\n'));
  });

  it('keeps the PR template aligned with the documented guidelines', () => {
    expect(existsSync(pullRequestTemplatePath)).toBe(true);
    expect(existsSync(prGuidelinesPath)).toBe(true);

    const template = readFileSync(pullRequestTemplatePath, 'utf8');
    const prGuidelines = readFileSync(prGuidelinesPath, 'utf8');
    const documentedTemplate = extractPrTemplate(prGuidelines);

    expect(normalizeMarkdown(template)).toBe(normalizeMarkdown(documentedTemplate));
  });

  it('provides OpenClaudeTag-specific Copilot review guidance', () => {
    expect(existsSync(copilotInstructionsPath)).toBe(true);

    const instructions = readFileSync(copilotInstructionsPath, 'utf8');

    // Brand is rebranded to OpenClaudeTag with no desensitization artifacts left over.
    expect(instructions).toContain('# OpenClaudeTag');
    expect(instructions).not.toContain('OpenClaw OpenClaudeTag');
    expect(instructions).not.toContain('@legacyname');
    expect(instructions).toContain('@open-tag/');

    // Highest-priority review checks must remain documented.
    expect(instructions).toContain('sendMessage');
    expect(instructions).toContain('createQueue()');
    expect(instructions).toContain('Image messages must preserve selected runtime');

    // Architecture constraints around event adaptation and the queue path.
    expect(instructions).toContain('adaptSdkEvent()');
    expect(instructions).toContain('Only `OPS_TASK` intent returns a direct reply');

    // Verification expectations spell out the build/test gate.
    expect(instructions).toContain('build');
    expect(instructions).toContain('unit test');
    expect(instructions).toContain('pnpm --filter @open-tag/api test:e2e');
  });
});
