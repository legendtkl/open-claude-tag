import type { z } from 'zod';
import type {
  AgentBotBindingSchema,
  AgentDelegationSchema,
  AgentProfileSchema,
  AgentSessionStateSchema,
  FeishuAppRegistrationSchema,
  UserIdentitySchema,
} from './schemas.js';

export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type FeishuAppRegistration = z.infer<typeof FeishuAppRegistrationSchema>;
export type AgentBotBinding = z.infer<typeof AgentBotBindingSchema>;
export type AgentSessionState = z.infer<typeof AgentSessionStateSchema>;
export type UserIdentity = z.infer<typeof UserIdentitySchema>;
export type AgentDelegation = z.infer<typeof AgentDelegationSchema>;
