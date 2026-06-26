import type { z } from 'zod';
import type { MemoryItemSchema } from './schemas.js';

export type MemoryItem = z.infer<typeof MemoryItemSchema>;
