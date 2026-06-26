import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Import after we set up the fixture dirs
async function importLoadSoul() {
  const { loadSoul } = await import('../soul-loader.js');
  return loadSoul;
}

describe('loadSoul', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `soul-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('concatenates SOUL.md and STYLE.md when both exist', async () => {
    await writeFile(join(tmpDir, 'SOUL.md'), '# Soul content');
    await writeFile(join(tmpDir, 'STYLE.md'), '# Style content');

    const loadSoul = await importLoadSoul();
    const result = loadSoul(tmpDir);

    expect(result).toContain('# Soul content');
    expect(result).toContain('# Style content');
    expect(result).toContain('\n\n');
  });

  it('returns only SOUL.md content when STYLE.md is missing', async () => {
    await writeFile(join(tmpDir, 'SOUL.md'), '# Soul only');

    const loadSoul = await importLoadSoul();
    const result = loadSoul(tmpDir);

    expect(result).toBe('# Soul only');
  });

  it('returns only STYLE.md content when SOUL.md is missing', async () => {
    await writeFile(join(tmpDir, 'STYLE.md'), '# Style only');

    const loadSoul = await importLoadSoul();
    const result = loadSoul(tmpDir);

    expect(result).toBe('# Style only');
  });

  it('returns empty string when no soul files exist', async () => {
    const loadSoul = await importLoadSoul();
    const result = loadSoul(tmpDir);

    expect(result).toBe('');
  });

  it('returns empty string when soul dir does not exist', async () => {
    const loadSoul = await importLoadSoul();
    const result = loadSoul(join(tmpDir, 'nonexistent'));

    expect(result).toBe('');
  });

  it('uses SOUL_DIR env var when soulDir param is not provided', async () => {
    await writeFile(join(tmpDir, 'SOUL.md'), '# From env');

    const original = process.env.SOUL_DIR;
    process.env.SOUL_DIR = tmpDir;
    try {
      const loadSoul = await importLoadSoul();
      const result = loadSoul();
      expect(result).toContain('# From env');
    } finally {
      if (original === undefined) {
        delete process.env.SOUL_DIR;
      } else {
        process.env.SOUL_DIR = original;
      }
    }
  });
});
