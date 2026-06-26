import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DAEMON_VERSION } from '../version.js';

describe('daemon version', () => {
  it('keeps DAEMON_VERSION in lockstep with package.json', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as {
      version: string;
    };
    expect(DAEMON_VERSION).toBe(pkg.version);
  });

  it('advertises the publishable 0.1.5 build', () => {
    expect(DAEMON_VERSION).toBe('0.1.5');
  });
});
