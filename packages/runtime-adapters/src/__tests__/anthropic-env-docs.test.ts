import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

const envExamplePath = new URL('../../../../.env.example', import.meta.url);

describe('.env.example Anthropic config', () => {
  it('documents the supported auth env aliases and precedence rule', () => {
    const content = readFileSync(envExamplePath, 'utf8');

    expect(content).toContain('ANTHROPIC_API_KEY=');
    expect(content).toContain('ANTHROPIC_AUTH_TOKEN=');
    expect(content).toContain('Configure either ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN');
    expect(content).toContain('ANTHROPIC_API_KEY takes precedence');
  });
});
