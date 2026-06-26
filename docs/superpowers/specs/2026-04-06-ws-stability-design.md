# WebSocket Stability Design

**Date:** 2026-04-06  
**Branch:** feat/local-process-manager (targeting main)  
**Replaces:** fix/ws-watchdog (obsolete after this change)

## Problem

Two independent stability issues observed in production:

### Issue 1: WS stuck in reconnect loop

The Feishu SDK `WSClient` can enter a broken state where `reConnect()` fires repeatedly but the `EventDispatcher` stops delivering events. The API process stays alive and `/health` returns `ok`, but no Feishu messages are received. Observed: stuck for hours without recovery.

### Issue 2: Worker health monitor false degraded alerts

`WorkerHealthMonitor` flips `healthy → degraded → healthy` every 30 seconds, roughly every 15–108 minutes. Root cause: the heartbeat stale threshold (`heartbeatMs * 3 = 30s`) is too tight and there is no hysteresis on the `degraded` transition. A single slightly-delayed heartbeat write (normal Node.js event loop jitter during pg-boss processing) triggers a false `degraded` event.

**Observed log pattern:**
```
02:36:26  healthy→degraded   (lasts exactly 30s)
02:36:56  degraded→healthy
02:52:24  healthy→degraded   (lasts exactly 30s)
02:52:54  degraded→healthy
... (8 occurrences between 02:00–10:00)
```

## Solution

### Fix 1: `WsWatchdog` class

New file: `apps/api/src/ws-watchdog.ts`

**Detection:** Track `lastActivityAt` via `recordActivity()` called from both `im.message.receive_v1` and `card.action.trigger` handlers in the `EventDispatcher`. No log interception — activity is measured at the application event boundary.

**Stale check:** A `setInterval` (60s) compares `Date.now() - lastActivityAt` against `currentThresholdMs`. If stale:
1. Call `currentWsClient.close({ force: true })` to cleanly release the old instance.
2. Call the `createWsClient` factory to build and `start` a fresh `WSClient`.
3. Apply backoff: `currentThresholdMs = min(currentThresholdMs * backoffFactor, maxThresholdMs)`.
4. Reset `lastActivityAt = Date.now()` to prevent immediate re-trigger.

**Backoff reset:** When `recordActivity()` is called, `currentThresholdMs` resets to `baseThresholdMs`. This ensures a recovered connection returns to normal sensitivity immediately.

**Backoff parameters (env-configurable):**

| Env var | Default | Meaning |
|---------|---------|---------|
| `WS_STALE_BASE_MS` | `600000` (10 min) | Initial stale threshold |
| `WS_STALE_MAX_MS` | `3600000` (60 min) | Maximum threshold after backoff |
| `WS_STALE_BACKOFF` | `2` | Multiplier per restart |

**Idle false-positive handling:** True idle periods (no messages, no card actions) trigger a harmless WSClient restart. After restart, backoff grows the threshold progressively (10 → 20 → 40 → 60 min), reducing noise for extended idle periods. Once activity resumes, threshold resets to base.

**Interface:**
```typescript
class WsWatchdog {
  constructor(config: WsWatchdogConfig)
  start(createWsClient: () => void): void
  stop(): void
  recordActivity(): void
  getStatus(): WsWatchdogStatus
}

interface WsWatchdogStatus {
  status: 'connected' | 'stale'  // 'restarting' omitted: restart is synchronous, not externally observable
  lastActivityAt: string          // ISO timestamp
  restartCount: number
  currentThresholdMs: number
}
```

**`server.ts` changes:**
- Replace the inline `wsClient` + watchdog state with a `WsWatchdog` instance.
- Inject `watchdog.recordActivity()` into both EventDispatcher handlers.
- Pass `startWsClient` factory (which builds and starts a new `WSClient`) to `watchdog.start()`.
- Call `watchdog.stop()` in the shutdown path.
- Add `ws: watchdog.getStatus()` to the `/health` response.

**`/health` response additions:**
```json
"ws": {
  "status": "connected",
  "lastActivityAt": "2026-04-06T08:00:00.000Z",
  "restartCount": 0,
  "currentThresholdMs": 600000
}
```

### Fix 2: `WorkerHealthMonitor` hysteresis

File: `apps/api/src/worker-health-monitor.ts`

**Changes:**

1. Add `consecutiveDegradedChecks: number` field (parallel to existing `consecutiveFailures`).

2. Change stale threshold multiplier from `3` to `5`:
   ```typescript
   // Before
   const staleThreshold = this.heartbeatMs * 3;   // 30s
   // After
   const staleThreshold = this.heartbeatMs * 5;   // 50s
   ```

3. Require 2 consecutive stale checks before transitioning to `degraded`:
   ```typescript
   if (elapsed > staleThreshold) {
     this.consecutiveDegradedChecks++;
     if (this.consecutiveDegradedChecks >= 2) {
       this.transitionTo('degraded');
     }
     return;
   }
   this.consecutiveDegradedChecks = 0;
   this.transitionTo('healthy');
   ```

4. Reset `consecutiveDegradedChecks = 0` on clean check and in `handleFailure`.

**Effect:** A single stale heartbeat is now silent. Two consecutive stale checks (60s apart) are needed to enter `degraded`. Combined with the wider threshold (50s vs 30s), normal event-loop jitter no longer triggers false alerts.

## Files Changed

| File | Change |
|------|--------|
| `apps/api/src/ws-watchdog.ts` | New — `WsWatchdog` class |
| `apps/api/src/server.ts` | Use `WsWatchdog`, add `ws` to health response |
| `apps/api/src/worker-health-monitor.ts` | Add hysteresis, widen stale threshold |
| `apps/api/src/__tests__/worker-health-monitor.test.ts` | Cover new hysteresis behavior |

## Out of Scope

- `fix/ws-watchdog` branch: superseded by this design, can be deleted after merge.
- `FeishuWsClient` in `packages/feishu-adapter/src/ws-client.ts`: not used by the API server; no changes needed.
- WS reconnect alerting via Feishu message: not added (health endpoint is sufficient for monitoring).
