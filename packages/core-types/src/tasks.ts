import type { z } from 'zod';
import type {
  TaskSpecSchema,
  TaskResultSchema,
  TaskConstraintsSchema,
  ArtifactRefSchema,
  RuntimeEventSchema,
  PlanStepSchema,
  PlanStepStatusSchema,
  ToolUseStatusSchema,
} from './schemas.js';

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type TaskConstraints = z.infer<typeof TaskConstraintsSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;
export type ToolUseStatus = z.infer<typeof ToolUseStatusSchema>;
