import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Keep the README guard in the API test suite because this package already owns the repo's
// Vitest wiring for CI, even though the files under test live at the repository root.
//
// The README overhaul (commit 0a352ab) split the former monolingual monolith into an
// English `README.md` plus a mirrored Chinese `README.zh-CN.md`; this guard validates
// that two-file structure rather than the old single-file `## English` / `## 中文` layout.
function readRepoFile(relativePath: string): string {
  const path = fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url));
  return readFileSync(resolve(path), 'utf8');
}

const readmeEn = readRepoFile('README.md');
const readmeZh = readRepoFile('README.zh-CN.md');

describe('README documentation', () => {
  it('ships an English README that links to its mirrored Chinese counterpart', () => {
    expect(readmeEn).toContain('## Features');
    expect(readmeEn).toContain('## Architecture');
    expect(readmeEn).toContain('./README.zh-CN.md');

    expect(readmeZh).toContain('## 功能特性');
    expect(readmeZh).toContain('## 架构');
  });

  it('covers complete contributor entry topics in both languages', () => {
    const englishSections = [
      '## Features',
      '## Architecture',
      '## Prerequisites',
      '## Quick Start',
      '## Feishu App Setup',
      '## Development Workflow',
      '## Testing',
      '## Troubleshooting',
    ];
    const chineseSections = [
      '## 功能特性',
      '## 架构',
      '## 前置依赖',
      '## 快速开始',
      '## 飞书应用配置',
      '## 开发流程',
      '## 测试与验证',
      '## 故障排查',
    ];

    for (const section of englishSections) {
      expect(readmeEn).toContain(section);
    }

    for (const section of chineseSections) {
      expect(readmeZh).toContain(section);
    }
  });

  it('documents canonical development and verification commands', () => {
    const commands = [
      'pnpm install',
      'pnpm build',
      'pnpm test',
      'pnpm --filter @open-tag/api test:e2e',
      'pnpm dev:api',
      'pnpm dev:worker',
    ];

    for (const command of commands) {
      expect(readmeEn).toContain(command);
    }
  });

  it('preserves critical Feishu setup and troubleshooting details', () => {
    const requiredDetails = [
      'im.message.receive_v1',
      'card.action.trigger',
      'im:message:send_as_bot',
      '200340',
      '200621',
      '"tag": "form"',
      '"form_container"',
      'separate from Event Configuration',
    ];

    for (const detail of requiredDetails) {
      expect(readmeEn).toContain(detail);
    }

    // The Chinese mirror carries the same operational permission/callback details.
    expect(readmeZh).toContain('im.message.receive_v1');
    expect(readmeZh).toContain('card.action.trigger');
  });

  it('links to deeper project guidance from the repository entry point', () => {
    expect(readmeEn).toContain('AGENTS.md');
    expect(readmeZh).toContain('AGENTS.md');
  });
});
