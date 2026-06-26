import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProbeList, runHealthAlert } from './service-health-alert.mjs';

function makeTempState() {
  const dir = mkdtempSync(join(tmpdir(), 'open-claude-tag-health-alert-'));
  return {
    dir,
    stateFile: join(dir, 'state.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('parseProbeList parses comma-delimited probe config', () => {
  assert.deepEqual(parseProbeList('api=http://a/health,console=http://b/admin'), [
    { name: 'api', url: 'http://a/health' },
    { name: 'console', url: 'http://b/admin' },
  ]);
});

test('runHealthAlert sends one down alert within cooldown and then a recovery alert', async () => {
  const temp = makeTempState();
  let nowMs = Date.parse('2026-06-16T09:00:00.000Z');
  const sentMessages = [];
  let apiHealthy = false;

  const fetchImpl = async (url, init) => {
    if (url === 'http://api/health') {
      return apiHealthy
        ? jsonResponse({ status: 'ok' })
        : jsonResponse({ status: 'degraded' });
    }
    if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, tenant_access_token: 'token' });
    }
    if (String(url).includes('/im/v1/messages')) {
      sentMessages.push(JSON.parse(init.body));
      return jsonResponse({ code: 0, data: { message_id: 'om_test' } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const env = {
    FEISHU_APP_ID: 'app',
    FEISHU_APP_SECRET: 'secret',
    OPEN_TAG_HEALTH_ALERT_RECEIVE_ID: 'alerts@example.com',
    OPEN_TAG_HEALTH_ALERT_RECEIVE_ID_TYPE: 'email',
    OPEN_TAG_HEALTH_PROBES: 'api=http://api/health',
    OPEN_TAG_HEALTH_ALERT_COOLDOWN_MS: '3600000',
    HOME: temp.dir,
  };

  try {
    const first = await runHealthAlert({
      env,
      envFile: '/missing/.env',
      stateFile: temp.stateFile,
      fetchImpl,
      now: () => nowMs,
    });
    assert.equal(first.status, 'down');
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].content, /service health alert/);

    nowMs += 60_000;
    const second = await runHealthAlert({
      env,
      envFile: '/missing/.env',
      stateFile: temp.stateFile,
      fetchImpl,
      now: () => nowMs,
    });
    assert.equal(second.status, 'down');
    assert.equal(sentMessages.length, 1);

    nowMs += 60_000;
    apiHealthy = true;
    const third = await runHealthAlert({
      env,
      envFile: '/missing/.env',
      stateFile: temp.stateFile,
      fetchImpl,
      now: () => nowMs,
    });
    assert.equal(third.status, 'healthy');
    assert.equal(sentMessages.length, 2);
    assert.match(sentMessages[1].content, /service health recovered/);
  } finally {
    temp.cleanup();
  }
});

test('runHealthAlert supports dry-run alerts without Feishu credentials', async () => {
  const temp = makeTempState();
  const fetchImpl = async () => jsonResponse({ status: 'degraded' });

  try {
    const result = await runHealthAlert({
      env: {
        OPEN_TAG_HEALTH_ALERT_DRY_RUN: 'true',
        OPEN_TAG_HEALTH_ALERT_RECEIVE_ID: 'oc_test',
        OPEN_TAG_HEALTH_PROBES: 'api=http://api/health',
        HOME: temp.dir,
      },
      envFile: '/missing/.env',
      stateFile: temp.stateFile,
      fetchImpl,
      now: () => Date.parse('2026-06-16T09:00:00.000Z'),
    });

    assert.equal(result.status, 'down');
    assert.equal(result.alert.dryRun, true);
    assert.match(result.alert.text, /health status degraded/);
    assert.equal(JSON.parse(readFileSync(temp.stateFile, 'utf8')).status, 'down');
  } finally {
    temp.cleanup();
  }
});
