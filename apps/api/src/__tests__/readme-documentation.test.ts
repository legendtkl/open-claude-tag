import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Keep the README guard in the API test suite because this package already owns the repo's
// Vitest wiring for CI, even though the files under test live at the repository root.
function readRepoFile(relativePath: string): string {
  const path = fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url));
  return readFileSync(resolve(path), 'utf8');
}

const readmeEn = readRepoFile('README.md');
const readmeZh = readRepoFile('README.zh-CN.md');

describe('README documentation', () => {
  it('links the English and Chinese repository entry points', () => {
    expect(readmeEn).toContain('[简体中文 / Chinese](./README.zh-CN.md)');
    expect(readmeZh).toContain('[English](./README.md)');
  });

  it('covers complete contributor entry topics in both languages', () => {
    const englishSections = [
      '## Features',
      '## Architecture',
      '## Prerequisites',
      '## Quick Start (Docker or your own Postgres)',
      '## Feishu App Setup',
      '## Development Workflow',
      '## Testing',
      '## Troubleshooting',
    ];
    const chineseSections = [
      '## 功能特性',
      '## 架构',
      '## 前置依赖',
      '## 快速开始（Docker 或自带 Postgres）',
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

  it('documents canonical development and verification commands in both languages', () => {
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
      expect(readmeZh).toContain(command);
    }
  });

  it('preserves critical Feishu setup and troubleshooting details', () => {
    const sharedDetails = [
      'im.message.receive_v1',
      'card.action.trigger',
      'im:message:send_as_bot',
      '200340',
      '200621',
      '"tag": "form"',
      '"form_container"',
    ];

    for (const detail of sharedDetails) {
      expect(readmeEn).toContain(detail);
      expect(readmeZh).toContain(detail);
    }

    expect(readmeEn).toContain('separate from Event Configuration');
    expect(readmeZh).toContain('独立于事件配置');
  });

  it('links to deeper project guidance from both repository entry points', () => {
    expect(readmeEn).toContain('AGENTS.md');
    expect(readmeZh).toContain('AGENTS.md');
  });
});
