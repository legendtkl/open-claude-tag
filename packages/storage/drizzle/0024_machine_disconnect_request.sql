-- D-A9: server-initiated machine disconnect. An admin closes a machine's current
-- daemon WebSocket from the console. `disconnect_requested_at` is a DB signal the
-- worker gateway honors on its liveness tick: a connection whose `connectedAt`
-- predates this timestamp is closed (the daemon may reconnect per its own backoff).
-- This is NOT a revoke — credentials stay valid; it only drops the current socket.

ALTER TABLE "machines" ADD COLUMN "disconnect_requested_at" timestamp with time zone;
