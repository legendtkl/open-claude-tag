import { mkdir, readFile, writeFile, chmod, stat } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { z } from 'zod';

/**
 * Persistent daemon credentials, written by `connect` and read by every other
 * subcommand (design §8). The file lives at `~/.open-claude-tag/daemon.json` with
 * mode 0600 — it holds the long-lived `machineSecret`, so it must never be
 * world-readable and the secret must never be logged.
 */
export const DaemonConfigSchema = z.object({
  serverUrl: z.string().url(),
  machineId: z.string().min(1),
  machineSecret: z.string().min(1),
  name: z.string().min(1),
});

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

/** Mode for the credential file: owner read/write only. */
const CONFIG_FILE_MODE = 0o600;

/**
 * Resolves the config file path. Honors `OPEN_TAG_HOME` so it stays aligned
 * with the workspace/home base used by `runtime-adapters`.
 */
export function resolveDaemonHome(): string {
  const home = process.env.OPEN_TAG_HOME?.trim() || join(homedir(), '.open-claude-tag');
  return home;
}

export function resolveConfigPath(): string {
  return join(resolveDaemonHome(), 'daemon.json');
}

/**
 * Creates the daemon's data directories under the OpenClaudeTag home:
 * `agents/` (stable per-agent homes — agent files and memory live here) and
 * `workspaces/` (per-dispatch scratch). Called at connect/install time so the
 * layout exists before the first dispatch. Idempotent; returns the paths.
 */
export async function ensureDataDirs(home = resolveDaemonHome()): Promise<{
  agentsDir: string;
  workspacesDir: string;
}> {
  const agentsDir = join(home, 'agents');
  // Honor the same WORKSPACES_ROOT override `runtime-adapters` and checks.ts use.
  const workspacesDir = process.env.WORKSPACES_ROOT?.trim() || join(home, 'workspaces');
  await mkdir(agentsDir, { recursive: true });
  await mkdir(workspacesDir, { recursive: true });
  return { agentsDir, workspacesDir };
}

/**
 * Writes the config to disk with mode 0600, creating the parent directory if
 * needed. The file is created with restrictive permissions from the start
 * (mode on `writeFile`) and `chmod`'d afterwards to tighten any pre-existing
 * file that may have had looser bits.
 */
export async function writeConfig(config: DaemonConfig, path = resolveConfigPath()): Promise<void> {
  const validated = DaemonConfigSchema.parse(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: CONFIG_FILE_MODE,
  });
  await chmod(path, CONFIG_FILE_MODE);
}

/**
 * Reads and validates the config. Returns `null` when the file is absent so
 * callers can render a friendly "run connect first" message instead of crashing.
 * A present-but-malformed file throws — silent acceptance would hide corruption.
 */
export async function readConfig(path = resolveConfigPath()): Promise<DaemonConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  return DaemonConfigSchema.parse(parsed);
}

/** True iff the config file exists and has mode 0600 (owner-only). */
export async function isConfigSecure(path = resolveConfigPath()): Promise<boolean> {
  try {
    const s = await stat(path);
    // Compare the low 9 permission bits against 0600.
    return (s.mode & 0o777) === CONFIG_FILE_MODE;
  } catch {
    return false;
  }
}

/**
 * Returns a copy of the config safe to log or print: the secret is replaced by
 * a fixed redaction marker. The full secret is NEVER returned by this function.
 */
export function redactConfig(config: DaemonConfig): Omit<DaemonConfig, 'machineSecret'> & {
  machineSecret: string;
} {
  return { ...config, machineSecret: '***redacted***' };
}
