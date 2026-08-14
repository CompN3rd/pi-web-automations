import type { JsonValue, WorkspaceBackendRequestContext } from "@jmfederico/pi-web/server-plugin-api";
import {
  AUTOMATIONS_CONTRACT_VERSION,
  AUTOMATIONS_OPERATIONS,
  type AutomationDraft,
  type AutomationPatch,
} from "../browser/contracts.js";
import { AutomationService, AutomationServiceError } from "./automation-service.js";
import type { AutomationScope, UpdateAutomationRequest } from "./contracts.js";

export class AutomationBackend {
  constructor(private readonly service: () => AutomationService | undefined) {}

  request(context: WorkspaceBackendRequestContext): Promise<JsonValue> {
    const service = this.service();
    if (service === undefined) throw new Error("Automations service is not ready");
    try {
      const value = toJsonValue(dispatch(service, context));
      return Promise.resolve({ contractVersion: AUTOMATIONS_CONTRACT_VERSION, ok: true, value });
    } catch (error) {
      if (!(error instanceof AutomationInputError || error instanceof AutomationServiceError)) throw error;
      return Promise.resolve({
        contractVersion: AUTOMATIONS_CONTRACT_VERSION,
        ok: false,
        error: { code: error instanceof AutomationInputError ? error.code : serviceErrorCode(error), message: error.message },
      });
    }
  }
}

function dispatch(service: AutomationService, context: WorkspaceBackendRequestContext): unknown {
  const scope = scopeFromContext(context);
  switch (context.operation) {
    case AUTOMATIONS_OPERATIONS.snapshot: {
      const input = recordWithKeys(context.input, ["contractVersion", "limit"]);
      requireVersion(input);
      const limit = input["limit"] === undefined ? 200 : integer(input["limit"], "limit", 1, 200);
      return {
        definitions: service.list(scope),
        runs: service.listRuns(scope, { limit }),
        ...service.models(),
        generatedAt: new Date().toISOString(),
      };
    }
    case AUTOMATIONS_OPERATIONS.create: {
      const input = recordWithKeys(context.input, ["contractVersion", "draft"]);
      requireVersion(input);
      return service.create(scope, parseDraft(input["draft"]));
    }
    case AUTOMATIONS_OPERATIONS.update: {
      const input = recordWithKeys(context.input, ["contractVersion", "automationId", "expectedRevision", "patch"]);
      requireVersion(input);
      const request: UpdateAutomationRequest = {
        ...scope,
        expectedRevision: integer(input["expectedRevision"], "expectedRevision", 1),
        ...parsePatch(input["patch"]),
      };
      return service.update(nonEmptyString(input["automationId"], "automationId"), request);
    }
    case AUTOMATIONS_OPERATIONS.delete: {
      const input = recordWithKeys(context.input, ["contractVersion", "automationId", "expectedRevision"]);
      requireVersion(input);
      service.delete(
        nonEmptyString(input["automationId"], "automationId"),
        scope,
        integer(input["expectedRevision"], "expectedRevision", 1),
      );
      return { deleted: true };
    }
    case AUTOMATIONS_OPERATIONS.runNow: {
      const input = recordWithKeys(context.input, ["contractVersion", "automationId", "expectedRevision"]);
      requireVersion(input);
      return service.runNow(
        nonEmptyString(input["automationId"], "automationId"),
        scope,
        integer(input["expectedRevision"], "expectedRevision", 1),
      );
    }
    case AUTOMATIONS_OPERATIONS.cancelRun: {
      const input = recordWithKeys(context.input, ["contractVersion", "runId"]);
      requireVersion(input);
      return service.cancel(nonEmptyString(input["runId"], "runId"), scope);
    }
    default:
      throw new AutomationInputError("unknown-operation", `Unknown Automations operation: ${context.operation}`);
  }
}

function scopeFromContext(context: WorkspaceBackendRequestContext): AutomationScope {
  return {
    projectId: context.project.id,
    workspaceId: context.workspace.id,
    workspacePath: context.workspace.path,
  };
}

function parseDraft(value: unknown): AutomationDraft {
  const record = recordWithKeys(value, ["name", "description", "prompt", "trigger", "model", "thinking", "timeoutMs"]);
  return {
    name: stringValue(record["name"], "name"),
    ...(record["description"] === undefined ? {} : { description: stringValue(record["description"], "description") }),
    prompt: stringValue(record["prompt"], "prompt"),
    trigger: parseTrigger(record["trigger"]),
    model: parseModel(record["model"]),
    thinking: parseThinking(record["thinking"]),
    ...(record["timeoutMs"] === undefined ? {} : { timeoutMs: integer(record["timeoutMs"], "timeoutMs", 1) }),
  };
}

function parsePatch(value: unknown): AutomationPatch {
  const record = recordWithKeys(value, ["name", "description", "prompt", "trigger", "model", "thinking", "timeoutMs", "enabled"]);
  return {
    ...(record["name"] === undefined ? {} : { name: stringValue(record["name"], "name") }),
    ...(record["description"] === undefined ? {} : { description: stringValue(record["description"], "description") }),
    ...(record["prompt"] === undefined ? {} : { prompt: stringValue(record["prompt"], "prompt") }),
    ...(record["trigger"] === undefined ? {} : { trigger: parseTrigger(record["trigger"]) }),
    ...(record["model"] === undefined ? {} : { model: parseModel(record["model"]) }),
    ...(record["thinking"] === undefined ? {} : { thinking: parseThinking(record["thinking"]) }),
    ...(record["timeoutMs"] === undefined ? {} : { timeoutMs: integer(record["timeoutMs"], "timeoutMs", 1) }),
    ...(record["enabled"] === undefined ? {} : { enabled: booleanValue(record["enabled"], "enabled") }),
  };
}

function parseTrigger(value: unknown): AutomationDraft["trigger"] {
  const record = requireRecord(value, "trigger");
  const type = stringValue(record["type"], "trigger.type");
  if (type === "manual") { requireKeys(record, ["type"]); return { type }; }
  if (type === "once") { requireKeys(record, ["type", "at"]); return { type, at: stringValue(record["at"], "trigger.at") }; }
  if (type === "interval") { requireKeys(record, ["type", "intervalMs"]); return { type, intervalMs: integer(record["intervalMs"], "trigger.intervalMs", 1) }; }
  if (type === "cron") {
    requireKeys(record, ["type", "expression", "timeZone"]);
    return { type, expression: stringValue(record["expression"], "trigger.expression"), timeZone: stringValue(record["timeZone"], "trigger.timeZone") };
  }
  throw new AutomationInputError("invalid-input", "trigger.type must be manual, once, interval, or cron");
}

function parseModel(value: unknown): AutomationDraft["model"] {
  const record = requireRecord(value, "model");
  const mode = stringValue(record["mode"], "model.mode");
  if (mode === "default") { requireKeys(record, ["mode"]); return { mode }; }
  if (mode === "fixed") {
    requireKeys(record, ["mode", "provider", "id", "name"]);
    return {
      mode,
      provider: stringValue(record["provider"], "model.provider"),
      id: stringValue(record["id"], "model.id"),
      ...(record["name"] === undefined ? {} : { name: stringValue(record["name"], "model.name") }),
    };
  }
  throw new AutomationInputError("invalid-input", "model.mode must be default or fixed");
}

function parseThinking(value: unknown): AutomationDraft["thinking"] {
  const record = requireRecord(value, "thinking");
  const mode = stringValue(record["mode"], "thinking.mode");
  if (mode === "default") { requireKeys(record, ["mode"]); return { mode }; }
  if (mode === "fixed") { requireKeys(record, ["mode", "level"]); return { mode, level: stringValue(record["level"], "thinking.level") }; }
  throw new AutomationInputError("invalid-input", "thinking.mode must be default or fixed");
}

function requireVersion(record: Record<string, unknown>): void {
  if (record["contractVersion"] !== AUTOMATIONS_CONTRACT_VERSION) throw new AutomationInputError("incompatible-contract", "Unsupported Automations contract version");
}
function recordWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = requireRecord(value, "input");
  requireKeys(record, keys);
  return record;
}
function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AutomationInputError("invalid-input", `${field} must be an object`);
  return Object.fromEntries(Object.entries(value));
}
function requireKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new AutomationInputError("invalid-input", `Unexpected input field: ${unexpected}`);
}
function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AutomationInputError("invalid-input", `${field} must be a string`);
  return value;
}
function nonEmptyString(value: unknown, field: string): string {
  const result = stringValue(value, field).trim();
  if (result === "") throw new AutomationInputError("invalid-input", `${field} is required`);
  return result;
}
function integer(value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new AutomationInputError("invalid-input", `${field} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  return value;
}
function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new AutomationInputError("invalid-input", `${field} must be a boolean`);
  return value;
}
function serviceErrorCode(error: AutomationServiceError): string {
  if (error.statusCode === 404) return "not-found";
  if (error.statusCode === 409) return "conflict";
  return error.statusCode === 500 ? "internal-error" : "invalid-input";
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Automations result contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) result[key] = toJsonValue(child);
    }
    return result;
  }
  throw new Error("Automations result is not JSON-compatible");
}

export class AutomationInputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
