import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Keep the README guard in the API test suite because this package already owns the repo's
// Vitest wiring for CI, even though the file under test lives at the repository root.
const readmePath = fileURLToPath(new URL('../../../../README.md', import.meta.url));
const readme = readFileSync(resolve(readmePath), 'utf8');

describe('README documentation', () => {
  it('provides mirrored Chinese and English top-level sections', () => {
    expect(readme).toContain('## English');
    expect(readme).toContain('## 中文');
  });

  it('covers complete contributor entry topics in both languages', () => {
    const englishSections = [
      '### Overview',
      '### Architecture',
      '### Prerequisites',
      '### Quick Start',
      '### Feishu App Setup',
      '### Development Workflow',
      '### Testing',
      '### Troubleshooting',
    ];
    const chineseSections = [
      '### 项目概览',
      '### 架构概览',
      '### 环境要求',
      '### 快速开始',
      '### 飞书应用配置',
      '### 开发流程',
      '### 测试与验证',
      '### 故障排查',
    ];

    for (const section of englishSections) {
      expect(readme).toContain(section);
    }

    for (const section of chineseSections) {
      expect(readme).toContain(section);
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
      expect(readme).toContain(command);
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
      '独立于 Event Configuration',
    ];

    for (const detail of requiredDetails) {
      expect(readme).toContain(detail);
    }
  });

  it('links to deeper project guidance from the repository entry point', () => {
    expect(readme).toContain('AGENTS.md');
  });
});
