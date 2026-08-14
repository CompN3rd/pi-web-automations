export type {
  AutomationAttempt,
  AutomationAttemptStatus,
  AutomationDefinition,
  AutomationDraft,
  AutomationModel,
  AutomationModelPolicy,
  AutomationPatch,
  AutomationRun,
  AutomationRunStatus,
  AutomationThinkingPolicy,
  AutomationTrigger,
  AutomationUsageSnapshot,
} from "../browser/contracts.js";

export interface AutomationScope {
  projectId: string;
  workspaceId: string;
  workspacePath: string;
}

export interface UpdateAutomationRequest extends AutomationScope {
  expectedRevision: number;
  name?: string;
  description?: string;
  prompt?: string;
  trigger?: import("../browser/contracts.js").AutomationTrigger;
  model?: import("../browser/contracts.js").AutomationModelPolicy;
  thinking?: import("../browser/contracts.js").AutomationThinkingPolicy;
  timeoutMs?: number;
  enabled?: boolean;
}
