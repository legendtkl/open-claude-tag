export {
  evaluateCrossChannelFlag,
  CROSS_CHANNEL_DECISION_ACTION,
  CROSS_CHANNEL_DELIVERY_ACTION,
  MAX_CANDIDATES,
} from './broker.js';
export { isCrossChannelEnabled, parseCrossChannelFlag } from './config.js';
export type { CrossChannelConfig } from './config.js';
export { renderCrossChannelFlag, CROSS_CHANNEL_MARKER } from './render.js';
export type {
  CrossChannelScope,
  CrossChannelFlag,
  FlagSeverity,
  CrossChannelAuditSeverity,
  CrossChannelAuditSink,
  CrossChannelDeliveryResolver,
  CrossChannelBrokerDeps,
  CrossChannelReason,
  CrossChannelTargetDecision,
  CrossChannelEvaluation,
} from './types.js';
