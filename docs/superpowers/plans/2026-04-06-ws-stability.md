# WebSocket Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two stability issues: WS stuck-reconnect loop (add `WsWatchdog`) and worker health monitor false degraded alerts (add hysteresis + wider stale threshold).

**Architecture:** `WsWatchdog` is a new standalone class in `apps/api/src/` that tracks EventDispatcher activity and restarts the SDK `WSClient` with exponential backoff when stale. `WorkerHealthMonitor` gets a `consecutiveDegradedChecks` counter and a wider stale multiplier to suppress single-heartbeat-miss alerts.

**Tech Stack:** TypeScript, Vitest (fake timers), `@larksuiteoapi/node-sdk` WSClient

---

## File Map

| File | Role |
|------|------|
| `apps/api/src/ws-watchdog.ts` | New — `WsWatchdog` class |
| `apps/api/src/__tests__/ws-watchdog.test.ts` | New — unit tests for `WsWatchdog` |
| `apps/api/src/server.ts` | Modified — wire `WsWatchdog`, add `ws` field to `/health` |
| `apps/api/src/worker-health-monitor.ts` | Modified — add `consecutiveDegradedChecks`, widen stale multiplier |
| `apps/api/src/__tests__/worker-health-monitor.test.ts` | Modified — add hysteresis tests |

---

## Task 1: `WsWatchdog` — write failing tests

**Files:**
- Create: `apps/api/src/__tests__/ws-watchdog.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// apps/api/src/__tests__/ws-watchdog.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WsWatchdog } from '../ws-watchdog.js';

vi.mock('@open-tag/observability', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('WsWatchdog', () => {
  let watchdog: WsWatchdog;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    watchdog?.stop();
    vi.useRealTimers();
  });

  it('starts with connected status and restartCount 0', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);

    const status = watchdog.getStatus();
    expect(status.status).toBe('connected');
    expect(status.restartCount).toBe(0);
    expect(status.currentThresholdMs).toBe(5000);
  });

  it('does not restart when activity is recent', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);

    watchdog.recordActivity();
    vi.advanceTimersByTime(60_000); // one check cycle

    expect(createWsClient).not.toHaveBeenCalled();
    expect(watchdog.getStatus().restartCount).toBe(0);
  });

  it('restarts when stale threshold exceeded', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);

    // Do NOT record activity — lastActivityAt stays at init time
    vi.advanceTimersByTime(5001);   // just past threshold
    vi.advanceTimersByTime(60_000); // trigger the 60s check

    expect(createWsClient).toHaveBeenCalledTimes(1);
    expect(watchdog.getStatus().restartCount).toBe(1);
  });

  it('applies backoff after each restart', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);

    // First restart
    vi.advanceTimersByTime(5001 + 60_000);
    expect(watchdog.getStatus().currentThresholdMs).toBe(10000);

    // Second restart — need to exceed new 10s threshold
    vi.advanceTimersByTime(10001 + 60_000);
    expect(watchdog.getStatus().currentThresholdMs).toBe(20000);

    // Third restart — already at max
    vi.advanceTimersByTime(20001 + 60_000);
    expect(watchdog.getStatus().currentThresholdMs).toBe(20000);

    expect(createWsClient).toHaveBeenCalledTimes(3);
  });

  it('resets threshold to base after activity is recorded', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);

    // Trigger one restart to push threshold to 10000
    vi.advanceTimersByTime(5001 + 60_000);
    expect(watchdog.getStatus().currentThresholdMs).toBe(10000);

    // Activity resets threshold
    watchdog.recordActivity();
    expect(watchdog.getStatus().currentThresholdMs).toBe(5000);
  });

  it('calls closeWsClient before restarting when provided', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2 });
    const createWsClient = vi.fn();
    const closeWsClient = vi.fn();
    watchdog.start(createWsClient, closeWsClient);

    vi.advanceTimersByTime(5001 + 60_000);

    expect(closeWsClient).toHaveBeenCalledTimes(1);
    expect(createWsClient).toHaveBeenCalledTimes(1);
    // close must be called before create
    expect(closeWsClient.mock.invocationCallOrder[0]).toBeLessThan(
      createWsClient.mock.invocationCallOrder[0],
    );
  });

  it('does not restart after stop()', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);
    watchdog.stop();

    vi.advanceTimersByTime(5001 + 60_000);

    expect(createWsClient).not.toHaveBeenCalled();
  });

  it('getStatus returns ISO lastActivityAt', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2 });
    watchdog.start(vi.fn());

    const { lastActivityAt } = watchdog.getStatus();
    expect(() => new Date(lastActivityAt)).not.toThrow();
    expect(new Date(lastActivityAt).toISOString()).toBe(lastActivityAt);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (module not found)**

```bash
pnpm --filter @open-tag/api test
```

Expected: FAIL — `Cannot find module '../ws-watchdog.js'`

---

## Task 2: `WsWatchdog` — implement

**Files:**
- Create: `apps/api/src/ws-watchdog.ts`

- [ ] **Step 1: Create the implementation**

```typescript
// apps/api/src/ws-watchdog.ts
import { createLogger } from '@open-tag/observability';

export interface WsWatchdogConfig {
  /** Initial stale threshold in ms. Default: WS_STALE_BASE_MS env or 600_000 (10 min) */
  baseThresholdMs?: number;
  /** Maximum threshold after backoff. Default: WS_STALE_MAX_MS env or 3_600_000 (60 min) */
  maxThresholdMs?: number;
  /** Backoff multiplier per restart. Default: WS_STALE_BACKOFF env or 2 */
  backoffFactor?: number;
  /** Check interval in ms. Default: 60_000 */
  checkIntervalMs?: number;
}

export interface WsWatchdogStatus {
  status: 'connected' | 'stale' | 'restarting';
  lastActivityAt: string;
  restartCount: number;
  currentThresholdMs: number;
}

const logger = createLogger('ws-watchdog');

export class WsWatchdog {
  private lastActivityAt: number;
  private restartCount = 0;
  private currentThresholdMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly baseThresholdMs: number;
  private readonly maxThresholdMs: number;
  private readonly backoffFactor: number;
  private readonly checkIntervalMs: number;

  constructor(config: WsWatchdogConfig = {}) {
    this.baseThresholdMs =
      config.baseThresholdMs ??
      parseInt(process.env.WS_STALE_BASE_MS ?? '600000', 10);
    this.maxThresholdMs =
      config.maxThresholdMs ??
      parseInt(process.env.WS_STALE_MAX_MS ?? '3600000', 10);
    this.backoffFactor =
      config.backoffFactor ??
      parseFloat(process.env.WS_STALE_BACKOFF ?? '2');
    this.checkIntervalMs = config.checkIntervalMs ?? 60_000;

    this.currentThresholdMs = this.baseThresholdMs;
    this.lastActivityAt = Date.now();
  }

  start(createWsClient: () => void, closeWsClient?: () => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const elapsed = Date.now() - this.lastActivityAt;
      if (elapsed <= this.currentThresholdMs) return;

      logger.warn(
        { elapsed, currentThresholdMs: this.currentThresholdMs, restartCount: this.restartCount },
        'WsWatchdog: stale connection detected, restarting WSClient',
      );

      if (closeWsClient) {
        try {
          closeWsClient();
        } catch (err) {
          logger.warn({ err }, 'WsWatchdog: error closing old WSClient');
        }
      }

      createWsClient();
      this.restartCount++;
      this.currentThresholdMs = Math.min(
        this.currentThresholdMs * this.backoffFactor,
        this.maxThresholdMs,
      );
      // Reset lastActivityAt so we don't immediately re-trigger
      this.lastActivityAt = Date.now();

      logger.info(
        { restartCount: this.restartCount, nextThresholdMs: this.currentThresholdMs },
        'WsWatchdog: WSClient restarted',
      );
    }, this.checkIntervalMs);

    this.timer.unref?.();
    logger.info(
      { baseThresholdMs: this.baseThresholdMs, maxThresholdMs: this.maxThresholdMs },
      'WsWatchdog started',
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('WsWatchdog stopped');
    }
  }

  recordActivity(): void {
    this.lastActivityAt = Date.now();
    if (this.currentThresholdMs !== this.baseThresholdMs) {
      this.currentThresholdMs = this.baseThresholdMs;
      logger.info(
        { currentThresholdMs: this.currentThresholdMs },
        'WsWatchdog: activity received, threshold reset to base',
      );
    }
  }

  getStatus(): WsWatchdogStatus {
    const elapsed = Date.now() - this.lastActivityAt;
    let status: WsWatchdogStatus['status'] = 'connected';
    if (elapsed > this.currentThresholdMs) {
      status = 'stale';
    }
    return {
      status,
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      restartCount: this.restartCount,
      currentThresholdMs: this.currentThresholdMs,
    };
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
pnpm --filter @open-tag/api test
```

Expected: all `WsWatchdog` tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/ws-watchdog.ts apps/api/src/__tests__/ws-watchdog.test.ts
git commit -m "feat(api): add WsWatchdog with exponential backoff restart"
```

---

## Task 3: Wire `WsWatchdog` into `server.ts`

**Files:**
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Add watchdog import and global variable**

At the top of `server.ts`, add import alongside other local imports:

```typescript
import { WsWatchdog } from './ws-watchdog.js';
```

In the globals section (around line 72, after `let workerHealthMonitor: WorkerHealthMonitor;`), add:

```typescript
let wsWatchdog: WsWatchdog;
```

Remove the existing watchdog-related globals if present (from `fix/ws-watchdog`):
- `let wsWatchdogTimer`
- `let lastWsMessageAt`
- `let wsReconnectsSinceLastMessage`
- `const WS_STALE_THRESHOLD_MS`

- [ ] **Step 2: Replace WSClient startup with watchdog-managed factory**

In the `start()` function, find the existing WSClient block (around line 757–767):

```typescript
// BEFORE (current server.ts)
const wsClient = new WSClient({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  loggerLevel: (process.env.LOG_LEVEL === 'debug' ? 4 : 3) as any,
});

// 7. Start WebSocket (non-blocking)
wsClient.start({ eventDispatcher }).catch((err) => {
  logger.warn({ err }, 'Feishu WSClient.start failed — HTTP server still running');
});
logger.info('Feishu WSClient starting...');
```

Replace with:

```typescript
// 7. Start WebSocket with watchdog
let activeWsClient: import('@larksuiteoapi/node-sdk').WSClient | null = null;

function startWsClient(): void {
  const client = new WSClient({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    loggerLevel: (process.env.LOG_LEVEL === 'debug' ? 4 : 3) as any,
  });
  activeWsClient = client;
  client.start({ eventDispatcher }).catch((err) => {
    logger.warn({ err }, 'Feishu WSClient.start failed — HTTP server still running');
  });
  logger.info('Feishu WSClient starting...');
}

function closeWsClient(): void {
  if (activeWsClient) {
    try {
      activeWsClient.close({ force: true });
    } catch (err) {
      logger.warn({ err }, 'Error closing WSClient');
    }
    activeWsClient = null;
  }
}

wsWatchdog = new WsWatchdog();
wsWatchdog.start(startWsClient, closeWsClient);
startWsClient();
```

- [ ] **Step 3: Add `recordActivity()` calls in both EventDispatcher handlers**

In the `im.message.receive_v1` handler (around line 727), add as the very first line inside the async callback:

```typescript
'im.message.receive_v1': async (data) => {
  wsWatchdog.recordActivity();   // <-- add this line
  logger.info(
    { messageId: data.message.message_id, data: JSON.stringify(data).slice(0, 500) },
    'Received Feishu message event',
  );
  // ... rest unchanged
```

In the `card.action.trigger` handler (around line 738), add as the very first line inside the async callback:

```typescript
'card.action.trigger': async (data: Record<string, unknown>) => {
  wsWatchdog.recordActivity();   // <-- add this line
  logger.info(
    { openMessageId: data.open_message_id, action: data.action },
    'Received Feishu card action',
  );
  // ... rest unchanged
```

- [ ] **Step 4: Add `ws` field to `/health` response**

In the `/health` handler (around line 435), add the watchdog status:

```typescript
// BEFORE
const workerSnapshot = workerHealthMonitor?.getSnapshot() ?? { status: 'unknown' as const };
const isDbDown = dbStatus !== 'connected';
const isWorkerDown = workerSnapshot.status === 'down';
const status = isDbDown || isWorkerDown ? 'degraded' : 'ok';
return {
  status,
  instanceId: INSTANCE_ID,
  instanceRole: INSTANCE_ROLE,
  timestamp: new Date().toISOString(),
  version: '0.1.0',
  db: dbStatus,
  port: PORT,
  queue: { size: queueSize },
  worker: workerSnapshot,
};

// AFTER
const workerSnapshot = workerHealthMonitor?.getSnapshot() ?? { status: 'unknown' as const };
const wsStatus = wsWatchdog?.getStatus() ?? { status: 'connected' as const, lastActivityAt: new Date().toISOString(), restartCount: 0, currentThresholdMs: 0 };
const isDbDown = dbStatus !== 'connected';
const isWorkerDown = workerSnapshot.status === 'down';
const status = isDbDown || isWorkerDown ? 'degraded' : 'ok';
return {
  status,
  instanceId: INSTANCE_ID,
  instanceRole: INSTANCE_ROLE,
  timestamp: new Date().toISOString(),
  version: '0.1.0',
  db: dbStatus,
  port: PORT,
  queue: { size: queueSize },
  worker: workerSnapshot,
  ws: wsStatus,
};
```

- [ ] **Step 5: Stop watchdog in shutdown**

In the `shutdown()` function (around line 830), add before `workerHealthMonitor?.stop()`:

```typescript
wsWatchdog?.stop();
```

- [ ] **Step 6: Build to check types**

```bash
pnpm --filter @open-tag/api build
```

Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat(api): wire WsWatchdog into server, expose ws status in /health"
```

---

## Task 4: `WorkerHealthMonitor` — add hysteresis tests

**Files:**
- Modify: `apps/api/src/__tests__/worker-health-monitor.test.ts`

- [ ] **Step 1: Add failing tests for degraded hysteresis**

Append the following tests inside the `describe('WorkerHealthMonitor')` block at the end, before the closing `}`):

```typescript
  it('does not transition to degraded on a single stale check', () => {
    // heartbeatMs=10_000, staleThreshold=10_000*5=50_000
    mockedReadPidRecord.mockReturnValue(
      makePidRecord({ lastHeartbeatAt: Date.now() - 55_000 }), // stale
    );
    monitor = new WorkerHealthMonitor({ intervalMs: 1000, workerHeartbeatMs: 10_000 });
    monitor.start();
    // First check: stale, but only 1 consecutive — should stay at previous status (unknown→stays unknown or healthy)
    // Actually initial state: the first check is the start() immediate check
    // single stale check should NOT go to degraded
    expect(monitor.getSnapshot().status).not.toBe('degraded');
  });

  it('transitions to degraded after 2 consecutive stale checks', () => {
    mockedReadPidRecord.mockReturnValue(
      makePidRecord({ lastHeartbeatAt: Date.now() - 55_000 }), // stale (>50s threshold)
    );
    monitor = new WorkerHealthMonitor({ intervalMs: 1000, workerHeartbeatMs: 10_000 });
    monitor.start();
    // First check at start(): stale but count=1, no degraded yet
    expect(monitor.getSnapshot().status).not.toBe('degraded');

    // Second check: still stale → count=2 → degraded
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('degraded');
  });

  it('resets degraded counter when heartbeat recovers mid-stale', () => {
    // First check: stale (count=1)
    mockedReadPidRecord.mockReturnValue(
      makePidRecord({ lastHeartbeatAt: Date.now() - 55_000 }),
    );
    monitor = new WorkerHealthMonitor({ intervalMs: 1000, workerHeartbeatMs: 10_000 });
    monitor.start();
    expect(monitor.getSnapshot().status).not.toBe('degraded');

    // Second check: fresh heartbeat → counter resets, stays healthy
    mockedReadPidRecord.mockReturnValue(makePidRecord());
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('healthy');

    // Third check: stale again → counter starts from 1 again, no degraded
    mockedReadPidRecord.mockReturnValue(
      makePidRecord({ lastHeartbeatAt: Date.now() - 55_000 }),
    );
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).not.toBe('degraded');
  });
```

- [ ] **Step 2: Run tests to verify new tests fail**

```bash
pnpm --filter @open-tag/api test
```

Expected: the 3 new hysteresis tests FAIL (current code goes to `degraded` on first stale check).

Also: the existing `'transitions to degraded when heartbeat is stale'` test still PASSES (we'll update it in Task 5 to reflect new behavior).

---

## Task 5: `WorkerHealthMonitor` — implement hysteresis

**Files:**
- Modify: `apps/api/src/worker-health-monitor.ts`

- [ ] **Step 1: Add `consecutiveDegradedChecks` field**

In the class body, after `private consecutiveFailures = 0;` (line 38), add:

```typescript
private consecutiveDegradedChecks = 0;
```

- [ ] **Step 2: Widen stale threshold multiplier**

In the `check()` method, change the stale threshold line:

```typescript
// BEFORE
const staleThreshold = this.heartbeatMs * 3;

// AFTER
const staleThreshold = this.heartbeatMs * 5;
```

- [ ] **Step 3: Add hysteresis to the degraded transition**

In the `check()` method, replace the stale-check block:

```typescript
// BEFORE
if (elapsed > staleThreshold) {
  this.consecutiveFailures = 0;
  this.transitionTo('degraded');
  return;
}

// All good
this.consecutiveFailures = 0;
this.transitionTo('healthy');
```

With:

```typescript
// AFTER
if (elapsed > staleThreshold) {
  this.consecutiveFailures = 0;
  this.consecutiveDegradedChecks++;
  if (this.consecutiveDegradedChecks >= 2) {
    this.transitionTo('degraded');
  }
  return;
}

// Heartbeat is fresh — reset both counters
this.consecutiveFailures = 0;
this.consecutiveDegradedChecks = 0;
this.transitionTo('healthy');
```

- [ ] **Step 4: Reset `consecutiveDegradedChecks` in `handleFailure`**

In the `handleFailure()` method, add reset alongside the existing logic:

```typescript
private handleFailure(reason: string): void {
  this.consecutiveFailures++;
  this.consecutiveDegradedChecks = 0;  // <-- add this line
  logger.debug({ reason, consecutiveFailures: this.consecutiveFailures }, 'Health check failure');

  if (this.consecutiveFailures >= 2) {
    this.transitionTo('down');
  }
}
```

- [ ] **Step 5: Update the existing stale test to match new behavior**

In `worker-health-monitor.test.ts`, the existing `'transitions to degraded when heartbeat is stale'` test currently expects degraded after one check. Update it to match 2-check requirement:

```typescript
it('transitions to degraded after two consecutive stale checks', () => {
  mockedReadPidRecord.mockReturnValue(
    makePidRecord({ lastHeartbeatAt: Date.now() - 60_000 }), // way past 5x10s=50s threshold
  );
  monitor = new WorkerHealthMonitor({ intervalMs: 1000, workerHeartbeatMs: 10_000 });
  monitor.start();
  // First check: stale, count=1, not yet degraded
  expect(monitor.getSnapshot().status).not.toBe('degraded');

  // Second check: still stale → degraded
  vi.advanceTimersByTime(1000);
  expect(monitor.getSnapshot().status).toBe('degraded');
});
```

- [ ] **Step 6: Run all tests to verify everything passes**

```bash
pnpm --filter @open-tag/api test
```

Expected: all tests PASS, including the 3 new hysteresis tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/worker-health-monitor.ts apps/api/src/__tests__/worker-health-monitor.test.ts
git commit -m "fix(api): add hysteresis to worker health degraded transition, widen stale threshold"
```

---

## Task 6: Full verification

- [ ] **Step 1: Full build**

```bash
pnpm build
```

Expected: no errors.

- [ ] **Step 2: Full unit test suite**

```bash
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 3: E2E gate**

```bash
pnpm --filter @open-tag/api test:e2e
```

Expected: PASS. (In a worktree use `pnpm test:e2e:isolated` instead.)

- [ ] **Step 4: Verify `/health` includes `ws` field**

Start the API (`pnpm dev:api`) and run:

```bash
curl -s http://localhost:3000/health | python3 -m json.tool | grep -A 6 '"ws"'
```

Expected output:
```json
"ws": {
    "status": "connected",
    "lastActivityAt": "...",
    "restartCount": 0,
    "currentThresholdMs": 600000
}
```

- [ ] **Step 5: Delete the obsolete branch**

```bash
git branch -d fix/ws-watchdog
```

If the worktree for that branch exists, remove it first:

```bash
git worktree remove .worktrees/fix-ws-watchdog --force
git branch -d fix/ws-watchdog
```

- [ ] **Step 6: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "chore(api): clean up obsolete fix/ws-watchdog worktree artifacts"
```
