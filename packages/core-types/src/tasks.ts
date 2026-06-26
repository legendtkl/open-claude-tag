import type { z } from 'zod';
import type {
  TaskSpecSchema,
  TaskResultSchema,
  TaskConstraintsSchema,
  ArtifactRefSchema,
  RuntimeEventSchema,
} from './schemas.js';

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type TaskConstraints = z.infer<typeof TaskConstraintsSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
