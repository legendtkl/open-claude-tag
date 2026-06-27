import type { DbMode, DbProvider } from './types.js';
import { createEmbeddedDbProvider } from './providers/embedded.js';
import { createDockerDbProvider } from './providers/docker.js';
import { createExternalDbProvider } from './providers/external.js';

export const DB_MODES: readonly DbMode[] = ['embedded', 'docker', 'external'];
export const DEFAULT_DB_MODE: DbMode = 'embedded';

/**
 * Resolve the DB mode from `OPEN_TAG_DB_MODE`. Defaults to `embedded` when
 * unset/empty; fails closed on an unrecognized value rather than guessing.
 */
export function resolveDbMode(env: NodeJS.ProcessEnv = process.env): DbMode {
  const raw = env.OPEN_TAG_DB_MODE?.trim();
  if (!raw) return DEFAULT_DB_MODE;
  if ((DB_MODES as readonly string[]).includes(raw)) {
    return raw as DbMode;
  }
  throw new Error(`Invalid OPEN_TAG_DB_MODE: "${raw}". Expected one of: ${DB_MODES.join(', ')}.`);
}

/**
 * Pure selector: map a mode to its provider. Construction is light — the
 * embedded provider lazy-loads `embedded-postgres` only when it actually boots.
 */
export function resolveDbProvider(mode: DbMode, env: NodeJS.ProcessEnv = process.env): DbProvider {
  switch (mode) {
    case 'embedded':
      return createEmbeddedDbProvider({ env });
    case 'docker':
      return createDockerDbProvider({ env });
    case 'external':
      return createExternalDbProvider({ env });
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unsupported db mode: ${String(exhaustive)}`);
    }
  }
}
