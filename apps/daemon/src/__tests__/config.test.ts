import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureDataDirs,
  writeConfig,
  readConfig,
  isConfigSecure,
  redactConfig,
  type DaemonConfig,
} from '../config.js';

const SAMPLE: DaemonConfig = {
  serverUrl: 'https://open-claude-tag.example.com',
  machineId: 'machine-123',
  machineSecret: 'super-secret-256-bit-value',
  name: 'laptop',
};

describe('config store', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'daemon-config-'));
    path = join(dir, 'daemon.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the agents and workspaces data dirs (idempotent)', async () => {
    const dirs = await ensureDataDirs(dir);
    expect(dirs.agentsDir).toBe(join(dir, 'agents'));
    expect(dirs.workspacesDir).toBe(join(dir, 'workspaces'));
    expect((await stat(dirs.agentsDir)).isDirectory()).toBe(true);
    expect((await stat(dirs.workspacesDir)).isDirectory()).toBe(true);
    // Second call must not throw on existing dirs.
    await expect(ensureDataDirs(dir)).resolves.toEqual(dirs);
  });

  it('writes the config with mode 0600', async () => {
    await writeConfig(SAMPLE, path);
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o600);
    expect(await isConfigSecure(path)).toBe(true);
  });

  it('round-trips the config', async () => {
    await writeConfig(SAMPLE, path);
    const loaded = await readConfig(path);
    expect(loaded).toEqual(SAMPLE);
  });

  it('returns null when the file is absent', async () => {
    expect(await readConfig(join(dir, 'missing.json'))).toBeNull();
  });

  it('tightens a pre-existing loose-mode file to 0600', async () => {
    await writeFile(path, JSON.stringify(SAMPLE), { mode: 0o644 });
    await chmod(path, 0o644);
    expect(await isConfigSecure(path)).toBe(false);
    await writeConfig(SAMPLE, path);
    expect(await isConfigSecure(path)).toBe(true);
  });

  it('throws on a malformed config rather than silently accepting it', async () => {
    await writeFile(path, JSON.stringify({ serverUrl: 'not-a-url' }));
    await expect(readConfig(path)).rejects.toThrow();
  });

  it('redacts the secret and never returns the real value', () => {
    const redacted = redactConfig(SAMPLE);
    expect(redacted.machineSecret).not.toBe(SAMPLE.machineSecret);
    expect(redacted.machineSecret).toBe('***redacted***');
    expect(redacted.machineId).toBe(SAMPLE.machineId);
  });

  it('does not write the secret in cleartext-only form that survives redaction', async () => {
    // The file legitimately contains the secret (0600), but the redacted view
    // used for logs/status must not.
    await writeConfig(SAMPLE, path);
    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toContain(SAMPLE.machineSecret); // file holds it (private)
    const printed = JSON.stringify(redactConfig(SAMPLE));
    expect(printed).not.toContain(SAMPLE.machineSecret); // logs never do
  });
});
