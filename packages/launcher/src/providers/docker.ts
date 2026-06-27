import { spawn } from 'child_process';
import { buildDatabaseUrl, resolveDockerConfig } from '../config.js';
import type { DbProvider } from '../types.js';

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { quiet?: boolean },
) => Promise<number>;

export interface DockerProviderDeps {
  env?: NodeJS.ProcessEnv;
  /** Runs a command and resolves with its exit code. Injectable for tests. */
  run?: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
  composeFile?: string;
  readinessAttempts?: number;
  readinessIntervalMs?: number;
}

const defaultRun: CommandRunner = (command, args, options) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: options?.quiet ? 'ignore' : 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Docker provider: brings up the compose Postgres (mirrors
 * `tools/setup/local.mjs`) and waits for `pg_isready`. `stop` is intentionally a
 * no-op because the compose Postgres may be shared by other tools/sessions.
 */
export function createDockerDbProvider(deps: DockerProviderDeps = {}): DbProvider {
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;
  const sleep = deps.sleep ?? defaultSleep;
  const composeFile = deps.composeFile ?? 'infra/docker-compose.yaml';
  const attempts = deps.readinessAttempts ?? 60;
  const intervalMs = deps.readinessIntervalMs ?? 1000;

  return {
    async ensureRunning() {
      const upCode = await run('docker', ['compose', '-f', composeFile, 'up', 'postgres', '-d']);
      if (upCode !== 0) {
        throw new Error(`\`docker compose up postgres\` failed with exit code ${upCode}.`);
      }

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const code = await run(
          'docker',
          ['compose', '-f', composeFile, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'open-claude-tag'],
          { quiet: true },
        );
        if (code === 0) {
          const databaseUrl = env.DATABASE_URL?.trim() || buildDatabaseUrl(resolveDockerConfig(env));
          return { databaseUrl };
        }
        await sleep(intervalMs);
      }
      throw new Error('Docker Postgres did not become ready in time.');
    },
    async stop() {
      // No-op: leave the shared compose Postgres lifecycle to the user / compose.
    },
  };
}
