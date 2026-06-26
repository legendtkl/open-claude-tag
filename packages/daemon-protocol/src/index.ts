// Wire protocol: envelope + frame schemas, parse/serialize helpers, size cap
export {
  ENVELOPE_VERSION,
  DAEMON_FEATURE_RUNTIME_ENV,
  DAEMON_FEATURE_AGENT_HOME,
  MAX_FRAME_BYTES,
  DaemonFeatureSchema,
  CapabilitiesSchema,
  WorkdirHintsSchema,
  InlineImageSchema,
  HelloErrorCodeSchema,
  HelloFrameSchema,
  HelloOkFrameSchema,
  HelloErrorFrameSchema,
  PingFrameSchema,
  PongFrameSchema,
  TaskDispatchFrameSchema,
  TaskAcceptedFrameSchema,
  TaskRejectedFrameSchema,
  TaskEventFrameSchema,
  EventAckFrameSchema,
  TaskLostFrameSchema,
  TaskCancelFrameSchema,
  ArtifactsFrameSchema,
  FrameSchema,
  parseFrame,
  parseRawFrame,
  serializeFrame,
  validateFrameSize,
} from './frames.js';
export type {
  Capabilities,
  DaemonFeature,
  WorkdirHints,
  InlineImage,
  HelloErrorCode,
  HelloFrame,
  HelloOkFrame,
  HelloErrorFrame,
  PingFrame,
  PongFrame,
  TaskDispatchFrame,
  TaskAcceptedFrame,
  TaskRejectedFrame,
  TaskEventFrame,
  EventAckFrame,
  TaskLostFrame,
  TaskCancelFrame,
  ArtifactsFrame,
  Frame,
  FrameType,
  ParseFrameResult,
} from './frames.js';

// Version negotiation
export { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_RANGE, isProtocolCompatible } from './version.js';
export type { ProtocolRange } from './version.js';

// Replay buffer (daemon side)
export { EventReplayBuffer } from './replay-buffer.js';
export type { BufferedEvent, EventReplayBufferOptions } from './replay-buffer.js';

// Seq dedup / in-order tracker (server side)
export { SeqTracker } from './seq-tracker.js';
