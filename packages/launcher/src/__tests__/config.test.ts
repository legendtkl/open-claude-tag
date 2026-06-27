import { describe, expect, it } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { buildDatabaseUrl, resolveDockerConfig, resolveEmbeddedConfig } from '../config.js';

describe('resolveEmbeddedConfig', () => {
  it('uses repo defaults when env is empty', () => {
    const config = resolveEmbeddedConfig({});
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 5432,
      user: 'open-claude-tag',
      password: 'open-claude-tag',
      database: 'open-claude-tag',
      dataDir: join(homedir(), '.open-claude-tag', 'pgdata'),
    });
  });

  it('honors OPEN_TAG_PG_PORT and OPEN_TAG_PG_DATA_DIR overrides', () => {
    const config = resolveEmbeddedConfig({
      OPEN_TAG_PG_PORT: '55432',
      OPEN_TAG_PG_DATA_DIR: '/tmp/custom-pgdata',
    });
    expect(config.port).toBe(55432);
    expect(config.dataDir).toBe('/tmp/custom-pgdata');
  });

  it('rejects an invalid port', () => {
    expect(() => resolveEmbeddedConfig({ OPEN_TAG_PG_PORT: 'not-a-port' })).toThrow(/Invalid OPEN_TAG_PG_PORT/);
    expect(() => resolveEmbeddedConfig({ OPEN_TAG_PG_PORT: '70000' })).toThrow(/Invalid OPEN_TAG_PG_PORT/);
  });
});

describe('resolveDockerConfig', () => {
  it('targets localhost with repo credentials', () => {
    expect(resolveDockerConfig({})).toMatchObject({
      host: 'localhost',
      port: 5432,
      user: 'open-claude-tag',
      database: 'open-claude-tag',
    });
  });
});

describe('buildDatabaseUrl', () => {
  it('renders a postgresql DSN', () => {
    const url = buildDatabaseUrl({
      host: '127.0.0.1',
      port: 55432,
      user: 'open-claude-tag',
      password: 'open-claude-tag',
      database: 'open-claude-tag',
    });
    expect(url).toBe('postgresql://open-claude-tag:open-claude-tag@127.0.0.1:55432/open-claude-tag');
  });
});
