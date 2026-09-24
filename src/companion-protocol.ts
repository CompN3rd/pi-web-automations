import type { AutomationModel, AutomationModelPolicy, AutomationThinkingPolicy, AutomationUsageSnapshot } from "./browser/contracts.js";

export const AUTOMATION_REQUEST = "pi-web-automations:request:v1";
export const AUTOMATION_REPLY = "pi-web-automations:reply:v1";
export interface AutomationPreparation { model: AutomationModelPolicy; thinking: AutomationThinkingPolicy }
export interface CompanionReply {
  requestId: string;
  operation: "prepare" | "run" | "cancel";
  status: "ready" | "completed" | "cancelled" | "failed" | "unknown";
  error?: string;
  model?: AutomationModel;
  thinkingLevel?: string;
  usage?: AutomationUsageSnapshot;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isRequest(value: unknown): value is Record<string, unknown> & { requestId: string; operation: string } {
  return isRecord(value) && typeof value["requestId"] === "string" && /^[a-f0-9-]{36}$/u.test(value["requestId"])
    && typeof value["operation"] === "string";
}
