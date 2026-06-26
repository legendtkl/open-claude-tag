# Admission Scheduler

OpenClaudeTag uses a worker-local admission scheduler before starting heavyweight runtime turns.

## Limits

- `AGENT_MAX_CONCURRENCY` bounds concurrently running runtime turns per agent. The running slot is held for the whole turn and released in the worker `finally` path.
- `MAX_CONCURRENT_AGENT_STARTS` bounds concurrent cold starts across the worker.
- `AGENT_START_INTERVAL_MS` spaces cold starts. The cold-start slot is released when the runtime emits its first event or when startup fails, not when the turn completes.

Defaults are intentionally conservative:

| Variable                            |                                             Default |
| ----------------------------------- | --------------------------------------------------: |
| `AGENT_MAX_CONCURRENCY`             | `WORKER_CONCURRENCY` in the worker (`5` by default) |
| `MAX_CONCURRENT_AGENT_STARTS`       |                                                 `5` |
| `AGENT_START_INTERVAL_MS`           |                                               `500` |
| `ADMISSION_RESCHEDULER_INTERVAL_MS` |                                              `1000` |
| `ADMISSION_RESCHEDULER_BATCH_SIZE`  |                                                `25` |

## Deferral

When a dequeued task is over budget, the worker writes or updates one `admission_leases` row and returns the active pg-boss handler. It does not enqueue another job with the same `singletonKey=sessionId` from inside the active handler.

A standalone delayed rescheduler polls due leases, reconstructs the queued task job from the database, and enqueues it. If pg-boss reports a singleton collision, the lease is kept and retried later. If the task is no longer queued, the lease is deleted.

## Worker Scope

The current implementation supports one worker process with multiple pg-boss pollers. In this mode the in-memory scheduler counters are authoritative.

For multiple worker processes, admission must be promoted to a database-owned lease path:

- acquire a short-lived worker lease for start/running slots with a Postgres advisory lock or row lock;
- heartbeat `admission_leases.lease_owner` and `lease_expires_at`;
- treat worker-local counters as a cache over database-owned slot state;
- reclaim expired leases before admitting new work.

Until that path is implemented, deployments should run a single worker process for strict per-agent and cold-start admission guarantees.
