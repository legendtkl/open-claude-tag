export { adaptNormalizedEvent } from './inbound-message.js';
export { deriveFeishuTaskAttachments } from './task-attachments.js';
export type { FeishuTaskAttachments } from './task-attachments.js';
export { LarkChannel } from './lark-channel.js';
export type {
  InboundMessage,
  AttachmentRef,
  Mention,
  ReferencedMessage,
  ConversationRef,
  ChannelScope,
} from '@open-tag/channel-core';
export {
  normalizeDocumentCommentEvent,
  normalizeEvent,
  normalizeEventForObservation,
} from './normalizer.js';
export type {
  NormalizedDocumentCommentEvent,
  NormalizedDocumentCommentMention,
  NormalizedDocumentCommentThreadReply,
  NormalizerConfig,
} from './normalizer.js';
export { parseReferencedFeishuMessage } from './referenced-message.js';
export type { FeishuMessageDetail } from './referenced-message.js';
export { checkAndRecordEvent, markEventProcessed, releaseInboundEventClaim } from './dedup.js';
export type { DedupResult } from './dedup.js';
export {
  buildAckCard,
  buildRunningCard,
  buildDoneCard,
  buildDoneCards,
  buildRichCompletionReplyCard,
  buildFailedCard,
  buildFailedCards,
  buildApprovalCard,
  buildWorkDirConfirmCard,
  TASK_CARD_ACTION_RETRY,
  TASK_CARD_ACTION_RETRY_RUNTIME,
  WORKDIR_FORM_SUBMIT,
  WORKDIR_FORM_CANCEL,
} from './card-builder.js';
export type {
  InteractiveCard,
  CardElement,
  TaskCardActionValue,
  WorkDirConfirmCardParams,
  WorkDirFormActionValue,
} from './card-builder.js';
export { FeishuClient } from './feishu-client.js';
export type { FeishuClientConfig, SendMessageResult } from './feishu-client.js';
export type {
  FeishuDocumentComment,
  FeishuDocumentCommentCreateElement,
  FeishuDocumentCommentCreateResult,
  FeishuDocumentCommentContentElement,
  FeishuDocumentCommentReply,
  FeishuDocumentCommentReplyReactionInput,
  FeishuDocumentCommentReplyResult,
  FeishuApplicationScopeApplyResult,
  FeishuApplicationScopeGrant,
  FeishuChatInfo,
  FeishuChatMember,
  FeishuTasklistMember,
} from './feishu-client.js';
export { ThreePhaseFeedback, createFeishuChannelSender } from './feedback.js';
export type { FeedbackChannelSender } from './feedback.js';
export { markdownToPost } from './markdown-to-post.js';
export type { PostContent } from './markdown-to-post.js';
export { LarkCli } from './lark-cli.js';
export type { LarkCliOptions, LarkCliResult } from './lark-cli.js';
export {
  FEISHU_TRACKING_STATUSES,
  TASK_INTERACTION_REASONS,
  mapTaskStatusToFeishuTrackingStatus,
  normalizeInteractionReason,
} from './task-tracking-mapping.js';
export type { FeishuTrackingStatus, TaskInteractionReason } from './task-tracking-mapping.js';
export {
  DrizzleFeishuTaskTrackingRepository,
  FeishuTaskSyncService,
  createFeishuTaskTrackingConfigFromEnv,
} from './feishu-task-sync.js';
export type {
  AddBotToChatTrackingSpaceInput,
  AddBotToChatTrackingSpaceResult,
  ApplyChatTasklistConfigurationInput,
  ApplyChatTasklistConfigurationResult,
  CleanCompletedChatTasksInput,
  CleanCompletedSessionTasksInput,
  CreateTrackedTaskInput,
  FeishuCompletedTaskLinkRecord,
  FeishuTaskCleanupResult,
  FeishuTaskLinkRecord,
  FeishuTaskTrackingConfig,
  FeishuTaskTrackingRepository,
  FeishuTaskTrackingSpace,
  InitializeChatTrackingSpaceInput,
  InitializeChatTrackingSpaceResult,
  SyncTrackedTaskStatusInput,
} from './feishu-task-sync.js';
