import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexCredsPresent, claudeCredsPresent } from '../__e2e__/runtime-live-creds.js';

/**
 * Unit-proves the self-skip predicates used by the opt-in live runtime e2e.
 * Runs in the DEFAULT suite (no model calls): credentials are simulated with a
 * throwaway home dir + injected env, never the host's real creds.
 */
describe('runtime live e2e credential predicates', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'runtime-creds-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function writeCred(relPath: string): void {
    const full = join(homeDir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '{}');
  }

  describe('codexCredsPresent', () => {
    it('is false with no env and no auth file', () => {
      expect(codexCredsPresent({ env: {}, homeDir })).toBe(false);
    });

    it('is true when CODEX_API_KEY is set', () => {
      expect(codexCredsPresent({ env: { CODEX_API_KEY: 'sk-x' }, homeDir })).toBe(true);
    });

    it('is true when OPENAI_API_KEY is set', () => {
      expect(codexCredsPresent({ env: { OPENAI_API_KEY: 'sk-x' }, homeDir })).toBe(true);
    });

    it('treats a blank env value as absent', () => {
      expect(codexCredsPresent({ env: { CODEX_API_KEY: '   ' }, homeDir })).toBe(false);
    });

    it('is true when ~/.codex/auth.json exists', () => {
      writeCred('.codex/auth.json');
      expect(codexCredsPresent({ env: {}, homeDir })).toBe(true);
    });

    it('does NOT treat config.toml alone as a credential', () => {
      writeCred('.codex/config.toml');
      expect(codexCredsPresent({ env: {}, homeDir })).toBe(false);
    });
  });

  describe('claudeCredsPresent', () => {
    it('is false with no env and no credentials file', () => {
      expect(claudeCredsPresent({ env: {}, homeDir })).toBe(false);
    });

    it('is true when ANTHROPIC_API_KEY is set', () => {
      expect(claudeCredsPresent({ env: { ANTHROPIC_API_KEY: 'sk-x' }, homeDir })).toBe(true);
    });

    it('is true when ANTHROPIC_AUTH_TOKEN is set', () => {
      expect(claudeCredsPresent({ env: { ANTHROPIC_AUTH_TOKEN: 'tok' }, homeDir })).toBe(true);
    });

    it('is true when ~/.claude/.credentials.json exists', () => {
      writeCred('.claude/.credentials.json');
      expect(claudeCredsPresent({ env: {}, homeDir })).toBe(true);
    });

    it('does NOT treat an empty ~/.claude dir as a credential', () => {
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      expect(claudeCredsPresent({ env: {}, homeDir })).toBe(false);
    });
  });
});
