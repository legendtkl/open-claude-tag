export { evaluateAmbientPost } from './gate.js';
export { isAmbientEnabled, parseAmbientFlag } from './config.js';
export type { AmbientConfig } from './config.js';
export {
  findStaleThreads,
  evaluateStaleThreadNudge,
  STALE_UNRESOLVED_STATUSES,
} from './stale-thread.js';
export type {
  StaleThreadCandidate,
  StaleThread,
  FindStaleThreadsOptions,
  StaleThreadNudgeInput,
  StaleThreadNudgeDecision,
  StaleThreadNudgeReason,
} from './stale-thread.js';
export type {
  AmbientInbound,
  AmbientPostInput,
  AmbientDecision,
  AmbientJudge,
  AmbientJudgePrompt,
  AmbientJudgeVerdict,
  BudgetStatus,
  BudgetCheck,
} from './types.js';
