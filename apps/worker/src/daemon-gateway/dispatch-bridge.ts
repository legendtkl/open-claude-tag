import type { Frame } from '@open-tag/daemon-protocol';

/**
 * The contract between the gateway (transport) and a {@link RemoteRuntimeAdapter}
 * instance (per-dispatch consumer). One bridge exists per in-flight dispatch.
 *
 * The gateway routes inbound daemon frames for a dispatchId to the registered
 * bridge's `onFrame`, and notifies it of connection state changes so the adapter
 * can run its 120 s disconnect grace (D12). The adapter sends outbound frames
 * (dispatch, ack, cancel) through `send`, which the gateway resolves to the
 * machine's current socket.
 */
export interface DispatchBridge {
  /** The machine this dispatch targets. */
  readonly machineId: string;
  /** Called for every validated daemon frame addressed to this dispatchId. */
  onFrame(frame: Frame): void;
  /** Called when the machine's socket connects (or reconnects). */
  onConnected(): void;
  /** Called when the machine's socket disconnects (flap or close). */
  onDisconnected(): void;
}

/** Outbound-send result so adapters can fail fast when no socket is live. */
export interface SendResult {
  ok: boolean;
}

/**
 * Gateway capabilities the adapter depends on. Narrowed to exactly what the
 * adapter needs so it can be faked in tests without standing up a real server.
 */
export interface GatewayDispatchPort {
  /** Whether the machine currently has a live, hello-completed socket. */
  isMachineOnline(machineId: string): boolean;
  /** Register a bridge for a dispatch; returns an unregister function. */
  registerDispatch(dispatchId: string, bridge: DispatchBridge): () => void;
  /** Send a frame to the machine's current socket; false when no socket. */
  sendToMachine(machineId: string, frame: Frame): SendResult;
}
