import type { z } from 'zod';
import type {
  NormalizedEventSchema,
  MentionSchema,
  ReferencedMessageEntrySchema,
  ReferencedMessageSchema,
} from './schemas.js';

export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;
export type Mention = z.infer<typeof MentionSchema>;
export type ReferencedMessageEntry = z.infer<typeof ReferencedMessageEntrySchema>;
export type ReferencedMessage = z.infer<typeof ReferencedMessageSchema>;
