export {
  resolveSession,
  upgradeProvisionalSession,
  aliasThreadKeysForSession,
  canonicalizeSessionId,
} from './resolve.js';
export type { ResolveResult } from './resolve.js';
export { transitionSessionLifecycle, touchSession, incrementMessageCount } from './lifecycle.js';
export { listSessions, useSession, getSessionStatus, closeSession } from './commands.js';
export type { SessionInfo } from './commands.js';
export {
  buildContext,
  compactSession,
  buildSharedContextSection,
  DEFAULT_BUDGET,
} from './context-builder.js';
export type {
  ContextBudget,
  BuiltContext,
  CompactResult,
  BuildContextOptions,
  SharedContextGist,
  ContextImageAttachment,
} from './context-builder.js';
export { selectContextStrategy } from './context-strategy.js';
export type {
  ContextStrategy,
  ContextStrategyMode,
  ContextStrategyInput,
  StoredSessionState,
  NextTurnAgent,
} from './context-strategy.js';
export { estimateTokens } from './token-estimator.js';
export {
  extractReplyLanguageFromMessageMetadata,
  getLatestUserReplyLanguage,
  resolvePreferredReplyLanguage,
} from './reply-language.js';
