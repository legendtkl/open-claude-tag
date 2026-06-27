import { describe, expect, it, vi } from 'vitest';
import { parseEnvFile, loadEffectiveEnv, ensureEnvFile } from '../env.js';

describe('parseEnvFile', () => {
  it('parses key=value, skips comments and blanks, strips quotes', () => {
    const parsed = parseEnvFile(['# comment', '', 'A=1', 'B = two ', 'C="quoted"', "D='q2'", 'E'].join('\n'));
    expect(parsed).toEqual({ A: '1', B: 'two', C: 'quoted', D: 'q2' });
  });
});

describe('loadEffectiveEnv', () => {
  it('overlays .env with the process env (shell wins over file)', () => {
    const env = loadEffectiveEnv(
      '/repo',
      { OPEN_TAG_DB_MODE: 'external', SHELL_ONLY: 'x' },
      {
        fileExists: () => true,
        readFile: () => 'OPEN_TAG_DB_MODE=embedded\nFILE_ONLY=y',
      },
    );
    expect(env.OPEN_TAG_DB_MODE).toBe('external'); // shell wins
    expect(env.FILE_ONLY).toBe('y');
    expect(env.SHELL_ONLY).toBe('x');
  });

  it('works with no .env file', () => {
    const env = loadEffectiveEnv('/repo', { A: '1' }, { fileExists: () => false, readFile: () => '' });
    expect(env.A).toBe('1');
  });
});

describe('ensureEnvFile', () => {
  it('copies .env.example when .env is missing', () => {
    const copyFile = vi.fn();
    const created = ensureEnvFile('/repo', {
      fileExists: (p) => p.endsWith('.env.example'),
      copyFile,
    });
    expect(created).toBe(true);
    expect(copyFile).toHaveBeenCalledWith('/repo/.env.example', '/repo/.env');
  });

  it('is a no-op when .env already exists', () => {
    const copyFile = vi.fn();
    const created = ensureEnvFile('/repo', { fileExists: () => true, copyFile });
    expect(created).toBe(false);
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('is a no-op when no example exists', () => {
    const copyFile = vi.fn();
    const created = ensureEnvFile('/repo', { fileExists: () => false, copyFile });
    expect(created).toBe(false);
    expect(copyFile).not.toHaveBeenCalled();
  });
});
