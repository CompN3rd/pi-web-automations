export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const AUTOMATIONS_CONTRACT_VERSION = 1;
export const AUTOMATIONS_OPERATIONS = Object.freeze({
  snapshot: "snapshot",
  create: "create",
  update: "update",
  delete: "delete",
  runNow: "run-now",
  cancelRun: "cancel-run",
} as const);

export type AutomationTrigger =
  | { type: "manual" }
  | { type: "once"; at: string }
  | { type: "interval"; intervalMs: number }
  | { type: "cron"; expression: string; timeZone: string };
export type AutomationModelPolicy =
  | { mode: "default" }
  | { mode: "fixed"; provider: string; id: string; name?: string };
export type AutomationThinkingPolicy =
  | { mode: "default" }
  | { mode: "fixed"; level: string };
export type AutomationRunSource = "manual" | "scheduled";
export type AutomationRunStatus = "queued" | "starting" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "timed_out" | "skipped" | "unknown";
export type AutomationAttemptStatus = "starting" | "running" | "aborting" | "completed" | "failed" | "cancelled" | "timed_out" | "unknown";
export type AutomationUsageQuality = "estimated" | "partial" | "provider_reported" | "unknown";

export interface AutomationModel {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: readonly string[];
}
export interface AutomationUsageSnapshot {
  scope: "root_session";
  quality: AutomationUsageQuality;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  estimatedCostMicros?: number;
  capturedAt: string;
}
export interface AutomationDefinition {
  id: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
  name: string;
  description?: string;
  prompt: string;
  enabled: boolean;
  revision: number;
  testedRevision?: number;
  trigger: AutomationTrigger;
  model: AutomationModelPolicy;
  thinking: AutomationThinkingPolicy;
  timeoutMs: number;
  abortGraceMs: number;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface AutomationAttempt {
  id: string;
  runId: string;
  attemptNumber: number;
  status: AutomationAttemptStatus;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  forceStopped: boolean;
  usage?: AutomationUsageSnapshot;
}
export interface AutomationRun {
  id: string;
  automationId: string;
  automationRevision: number;
  automationName: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
  source: AutomationRunSource;
  scheduledFor: string;
  status: AutomationRunStatus;
  prompt: string;
  trigger: AutomationTrigger;
  configuredModel: AutomationModelPolicy;
  configuredThinking: AutomationThinkingPolicy;
  actualModel?: AutomationModel;
  actualThinkingLevel?: string;
  timeoutMs: number;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  deadlineAt?: string;
  cancelRequestedAt?: string;
  cancellationKind?: "user" | "timeout";
  sessionId?: string;
  reason?: string;
  error?: string;
  usage?: AutomationUsageSnapshot;
  attempt?: AutomationAttempt;
}
export interface AutomationDraft {
  name: string;
  description?: string;
  prompt: string;
  trigger: AutomationTrigger;
  model: AutomationModelPolicy;
  thinking: AutomationThinkingPolicy;
  timeoutMs?: number;
}
export interface AutomationPatch {
  name?: string;
  description?: string;
  prompt?: string;
  trigger?: AutomationTrigger;
  model?: AutomationModelPolicy;
  thinking?: AutomationThinkingPolicy;
  timeoutMs?: number;
  enabled?: boolean;
}
export interface AutomationSnapshot {
  definitions: AutomationDefinition[];
  runs: AutomationRun[];
  models: AutomationModel[];
  thinkingLevels: string[];
  defaultTimeoutMs: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  generatedAt: string;
}

export interface AutomationError { code: string; message: string }
export type AutomationEnvelope<T extends JsonValue = JsonValue> =
  | { contractVersion: 1; ok: true; value: T }
  | { contractVersion: 1; ok: false; error: AutomationError };

export function parseAutomationEnvelope(value: unknown): AutomationEnvelope {
  if (!isRecord(value) || value["contractVersion"] !== AUTOMATIONS_CONTRACT_VERSION || typeof value["ok"] !== "boolean") {
    throw new Error("Invalid Automations backend response");
  }
  if (value["ok"]) {
    if (!("value" in value) || !isJsonValue(value["value"])) throw new Error("Invalid Automations success response");
    return { contractVersion: 1, ok: true, value: value["value"] };
  }
  const error = value["error"];
  if (!isRecord(error) || typeof error["code"] !== "string" || typeof error["message"] !== "string") {
    throw new Error("Invalid Automations error response");
  }
  return { contractVersion: 1, ok: false, error: { code: error["code"], message: error["message"] } };
}

export function parseAutomationSnapshot(value: unknown): AutomationSnapshot {
  const record = expectRecord(value, "snapshot");
  return {
    definitions: expectArray(record["definitions"], "definitions").map(parseDefinition),
    runs: expectArray(record["runs"], "runs").map(parseRun),
    models: expectArray(record["models"], "models").map(parseModel),
    thinkingLevels: expectArray(record["thinkingLevels"], "thinkingLevels").map((level) => expectString(level, "thinking level")),
    defaultTimeoutMs: expectNumber(record["defaultTimeoutMs"], "defaultTimeoutMs"),
    minTimeoutMs: expectNumber(record["minTimeoutMs"], "minTimeoutMs"),
    maxTimeoutMs: expectNumber(record["maxTimeoutMs"], "maxTimeoutMs"),
    generatedAt: expectString(record["generatedAt"], "generatedAt"),
  };
}

export function parseAutomationDefinition(value: unknown): AutomationDefinition {
  return parseDefinition(value);
}

export function parseAutomationRun(value: unknown): AutomationRun {
  return parseRun(value);
}

function parseDefinition(value: unknown): AutomationDefinition {
  const record = expectRecord(value, "automation definition");
  const trigger = parseTrigger(record["trigger"]);
  const model = parseModelPolicy(record["model"]);
  const thinking = parseThinkingPolicy(record["thinking"]);
  const description = optionalString(record["description"], "definition.description");
  const testedRevision = optionalNumber(record["testedRevision"], "definition.testedRevision");
  const nextRunAt = optionalString(record["nextRunAt"], "definition.nextRunAt");
  return {
    id: expectString(record["id"], "definition.id"),
    projectId: expectString(record["projectId"], "definition.projectId"),
    workspaceId: expectString(record["workspaceId"], "definition.workspaceId"),
    workspacePath: expectString(record["workspacePath"], "definition.workspacePath"),
    name: expectString(record["name"], "definition.name"),
    ...(description === undefined ? {} : { description }),
    prompt: expectString(record["prompt"], "definition.prompt"),
    enabled: expectBoolean(record["enabled"], "definition.enabled"),
    revision: expectNumber(record["revision"], "definition.revision"),
    ...(testedRevision === undefined ? {} : { testedRevision }),
    trigger,
    model,
    thinking,
    timeoutMs: expectNumber(record["timeoutMs"], "definition.timeoutMs"),
    abortGraceMs: expectNumber(record["abortGraceMs"], "definition.abortGraceMs"),
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    createdAt: expectString(record["createdAt"], "definition.createdAt"),
    updatedAt: expectString(record["updatedAt"], "definition.updatedAt"),
  };
}

function parseRun(value: unknown): AutomationRun {
  const record = expectRecord(value, "automation run");
  const actualThinkingLevel = optionalString(record["actualThinkingLevel"], "run.actualThinkingLevel");
  return {
    id: expectString(record["id"], "run.id"), automationId: expectString(record["automationId"], "run.automationId"),
    automationRevision: expectNumber(record["automationRevision"], "run.automationRevision"), automationName: expectString(record["automationName"], "run.automationName"),
    projectId: expectString(record["projectId"], "run.projectId"), workspaceId: expectString(record["workspaceId"], "run.workspaceId"), workspacePath: expectString(record["workspacePath"], "run.workspacePath"),
    source: expectEnum(record["source"], ["manual", "scheduled"], "run.source"), scheduledFor: expectString(record["scheduledFor"], "run.scheduledFor"),
    status: expectEnum(record["status"], ["queued", "starting", "running", "cancelling", "completed", "failed", "cancelled", "timed_out", "skipped", "unknown"], "run.status"),
    prompt: expectString(record["prompt"], "run.prompt"), trigger: parseTrigger(record["trigger"]), configuredModel: parseModelPolicy(record["configuredModel"]), configuredThinking: parseThinkingPolicy(record["configuredThinking"]),
    ...(record["actualModel"] === undefined ? {} : { actualModel: parseModel(record["actualModel"]) }),
    ...(actualThinkingLevel === undefined ? {} : { actualThinkingLevel }),
    timeoutMs: expectNumber(record["timeoutMs"], "run.timeoutMs"), queuedAt: expectString(record["queuedAt"], "run.queuedAt"),
    ...optionalRunFields(record),
    ...(record["usage"] === undefined ? {} : { usage: parseUsage(record["usage"]) }),
    ...(record["attempt"] === undefined ? {} : { attempt: parseAttempt(record["attempt"]) }),
  };
}

function optionalRunFields(record: Record<string, unknown>): Partial<AutomationRun> {
  const result: Partial<AutomationRun> = {};
  for (const key of ["startedAt", "completedAt", "deadlineAt", "cancelRequestedAt", "sessionId", "reason", "error"] as const) {
    const value = optionalString(record[key], `run.${key}`); if (value !== undefined) result[key] = value;
  }
  const kind = record["cancellationKind"];
  if (kind !== undefined) result.cancellationKind = expectEnum(kind, ["user", "timeout"], "run.cancellationKind");
  return result;
}

function parseAttempt(value: unknown): AutomationAttempt {
  const record = expectRecord(value, "run attempt");
  return {
    id: expectString(record["id"], "attempt.id"), runId: expectString(record["runId"], "attempt.runId"), attemptNumber: expectNumber(record["attemptNumber"], "attempt.attemptNumber"),
    status: expectEnum(record["status"], ["starting", "running", "aborting", "completed", "failed", "cancelled", "timed_out", "unknown"], "attempt.status"),
    forceStopped: expectBoolean(record["forceStopped"], "attempt.forceStopped"),
    ...optionalAttemptFields(record), ...(record["usage"] === undefined ? {} : { usage: parseUsage(record["usage"]) }),
  };
}

function optionalAttemptFields(record: Record<string, unknown>): Partial<AutomationAttempt> {
  const result: Partial<AutomationAttempt> = {};
  for (const key of ["sessionId", "startedAt", "completedAt", "error"] as const) {
    const value = optionalString(record[key], `attempt.${key}`); if (value !== undefined) result[key] = value;
  }
  return result;
}

function parseUsage(value: unknown): AutomationUsageSnapshot {
  const record = expectRecord(value, "usage"); const tokens = expectRecord(record["tokens"], "usage.tokens");
  const estimatedCostMicros = optionalNumber(record["estimatedCostMicros"], "usage.estimatedCostMicros");
  return {
    scope: expectEnum(record["scope"], ["root_session"], "usage.scope"), quality: expectEnum(record["quality"], ["estimated", "partial", "provider_reported", "unknown"], "usage.quality"),
    tokens: { input: expectNumber(tokens["input"], "tokens.input"), output: expectNumber(tokens["output"], "tokens.output"), cacheRead: expectNumber(tokens["cacheRead"], "tokens.cacheRead"), cacheWrite: expectNumber(tokens["cacheWrite"], "tokens.cacheWrite"), total: expectNumber(tokens["total"], "tokens.total") },
    ...(estimatedCostMicros === undefined ? {} : { estimatedCostMicros }),
    capturedAt: expectString(record["capturedAt"], "usage.capturedAt"),
  };
}

function parseModel(value: unknown): AutomationModel {
  const record = expectRecord(value, "model");
  return { provider: expectString(record["provider"], "model.provider"), id: expectString(record["id"], "model.id"), name: expectString(record["name"], "model.name"), thinkingLevels: expectArray(record["thinkingLevels"], "model.thinkingLevels").map((level) => expectString(level, "thinking level")) };
}
function parseTrigger(value: unknown): AutomationTrigger {
  const record = expectRecord(value, "trigger"); const type = expectString(record["type"], "trigger.type");
  if (type === "manual") return { type };
  if (type === "once") return { type, at: expectString(record["at"], "trigger.at") };
  if (type === "interval") return { type, intervalMs: expectNumber(record["intervalMs"], "trigger.intervalMs") };
  if (type === "cron") return { type, expression: expectString(record["expression"], "trigger.expression"), timeZone: expectString(record["timeZone"], "trigger.timeZone") };
  throw invalid("trigger.type");
}
function parseModelPolicy(value: unknown): AutomationModelPolicy {
  const record = expectRecord(value, "model policy"); const mode = expectString(record["mode"], "model.mode");
  if (mode === "default") return { mode };
  if (mode === "fixed") {
    const name = optionalString(record["name"], "model.name");
    return { mode, provider: expectString(record["provider"], "model.provider"), id: expectString(record["id"], "model.id"), ...(name === undefined ? {} : { name }) };
  }
  throw invalid("model.mode");
}
function parseThinkingPolicy(value: unknown): AutomationThinkingPolicy {
  const record = expectRecord(value, "thinking policy"); const mode = expectString(record["mode"], "thinking.mode");
  if (mode === "default") return { mode };
  if (mode === "fixed") return { mode, level: expectString(record["level"], "thinking.level") };
  throw invalid("thinking.mode");
}
function expectRecord(value: unknown, field: string): Record<string, unknown> { if (!isRecord(value)) throw invalid(field); return value; }
function expectArray(value: unknown, field: string): unknown[] { if (!Array.isArray(value)) throw invalid(field); return value; }
function expectString(value: unknown, field: string): string { if (typeof value !== "string") throw invalid(field); return value; }
function optionalString(value: unknown, field: string): string | undefined { return value === undefined ? undefined : expectString(value, field); }
function expectNumber(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(field); return value; }
function optionalNumber(value: unknown, field: string): number | undefined { return value === undefined ? undefined : expectNumber(value, field); }
function expectBoolean(value: unknown, field: string): boolean { if (typeof value !== "boolean") throw invalid(field); return value; }
function expectEnum<T extends string>(value: unknown, values: readonly T[], field: string): T { const text = expectString(value, field); const match = values.find((candidate) => candidate === text); if (match === undefined) throw invalid(field); return match; }
function invalid(field: string): Error { return new Error(`Invalid Automations ${field}`); }

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
