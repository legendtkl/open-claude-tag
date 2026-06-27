import { describe, expect, it } from 'vitest';
import { resolvePersonalConfig, PERSONAL_INSTANCE_ID } from '../config.js';

const REPO = '/repo';

describe('resolvePersonalConfig', () => {
  it('defaults to embedded mode, port 3000/8080, and a port-keyed runtime dir', () => {
    const config = resolvePersonalConfig({}, { repoRoot: REPO });
    expect(config.dbMode).toBe('embedded');
    expect(config.apiPort).toBe(3000);
    expect(config.consolePort).toBe(8080);
    expect(config.apiUrl).toBe('http://127.0.0.1:3000');
    expect(config.consoleUrl).toBe('http://127.0.0.1:8080');
    expect(config.healthUrl).toBe('http://127.0.0.1:3000/health');
    expect(config.runtimeDir).toBe('/tmp/open-claude-tag/personal/3000');
    expect(config.apiPidPath).toBe('/tmp/open-claude-tag/personal/3000/api.pid.json');
    expect(config.dbHostPidPath).toBe('/tmp/open-claude-tag/personal/3000/db-host.pid.json');
    expect(config.lockPath).toBe('/tmp/open-claude-tag/personal/3000/up.lock');
    expect(config.embedded).toBeDefined();
    expect(config.embedded?.port).toBe(5432);
  });

  it('keys the runtime dir by the api port so isolated ports do not collide', () => {
    const config = resolvePersonalConfig({ OPEN_TAG_API_PORT: '4555' }, { repoRoot: REPO });
    expect(config.apiPort).toBe(4555);
    expect(config.runtimeDir).toBe('/tmp/open-claude-tag/personal/4555');
  });

  it('honors OPEN_TAG_CONSOLE_PORT and OPEN_TAG_PG_PORT', () => {
    const config = resolvePersonalConfig(
      { OPEN_TAG_CONSOLE_PORT: '9001', OPEN_TAG_PG_PORT: '5599' },
      { repoRoot: REPO },
    );
    expect(config.consolePort).toBe(9001);
    expect(config.embedded?.port).toBe(5599);
  });

  it('defaults Feishu access to disabled and only enables on explicit opt-in', () => {
    expect(resolvePersonalConfig({}, { repoRoot: REPO }).feishuAccess).toBe('disabled');
    expect(
      resolvePersonalConfig({ OPEN_TAG_FEISHU_ACCESS: 'enabled' }, { repoRoot: REPO }).feishuAccess,
    ).toBe('enabled');
    expect(
      resolvePersonalConfig({ OPEN_TAG_FEISHU_ACCESS: 'anything-else' }, { repoRoot: REPO })
        .feishuAccess,
    ).toBe('disabled');
  });

  it('omits the embedded config for docker/external modes', () => {
    expect(resolvePersonalConfig({ OPEN_TAG_DB_MODE: 'docker' }, { repoRoot: REPO }).embedded).toBeUndefined();
    expect(resolvePersonalConfig({ OPEN_TAG_DB_MODE: 'external' }, { repoRoot: REPO }).embedded).toBeUndefined();
  });

  it('fails closed on an unknown db mode', () => {
    expect(() => resolvePersonalConfig({ OPEN_TAG_DB_MODE: 'sqlite' }, { repoRoot: REPO })).toThrow(
      /Invalid OPEN_TAG_DB_MODE/,
    );
  });

  it('rejects an invalid api port', () => {
    expect(() => resolvePersonalConfig({ OPEN_TAG_API_PORT: 'abc' }, { repoRoot: REPO })).toThrow(
      /Invalid OPEN_TAG_API_PORT/,
    );
  });

  it('exposes the forced personal instance id constant', () => {
    expect(PERSONAL_INSTANCE_ID).toBe('personal');
  });
});
