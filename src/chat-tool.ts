import { createCompanionBackend } from "@jmfederico/pi-web/server-plugin-api";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chatRecord } from "./browser/chat-protocol.js";

// Plain JSON Schema keeps the compiled companion free of host runtime dependencies.
const textSchema = { type: "string" };
const defaultPolicy = { type: "object", properties: { mode: { const: "default" } }, required: ["mode"], additionalProperties: false };
const requirements = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  description: { type: "string", maxLength: 500, description: "Empty string clears the description" },
  prompt: { type: "string", minLength: 1, maxLength: 100000 },
  trigger: { oneOf: [
    { type: "object", properties: { type: { const: "manual" } }, required: ["type"], additionalProperties: false },
    { type: "object", properties: { type: { const: "once" }, at: textSchema }, required: ["type", "at"], additionalProperties: false },
    { type: "object", properties: { type: { const: "interval" }, intervalMs: { type: "integer", minimum: 60000 } }, required: ["type", "intervalMs"], additionalProperties: false },
    { type: "object", properties: { type: { const: "cron" }, expression: textSchema, timeZone: textSchema }, required: ["type", "expression", "timeZone"], additionalProperties: false },
  ], description: "manual, future ISO once, interval >=60000ms, or six-field cron with IANA timeZone" },
  model: { oneOf: [defaultPolicy, { type: "object", properties: { mode: { const: "fixed" }, provider: textSchema, id: textSchema, name: textSchema }, required: ["mode", "provider", "id"], additionalProperties: false }] },
  thinking: { oneOf: [defaultPolicy, { type: "object", properties: { mode: { const: "fixed" }, level: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] } }, required: ["mode", "level"], additionalProperties: false }] },
  timeoutMs: { type: "integer", minimum: 60000, maximum: 86400000, description: "Default 3600000ms" },
};

export function registerAutomationChatTool(pi: Pick<ExtensionAPI, "on" | "events" | "registerTool">): void {
  // Deferred tool definitions are not initially model-visible. Keep only discovery
  // guidance in the prompt; the full operation schema is loaded on demand.
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + "\nFor durable scheduled jobs, discover the deferred automations tool with tool_search. It lists exact registered workspace targets, saves disabled drafts, and manages test-before-enable schedules on this session's hosting machine. Do not inspect databases or load skills as a fallback.",
  }));
  pi.registerTool({
    name: "automations",
    label: "Automations",
    exposure: "deferred",
    promptSnippet: "Manage durable Automations: discover the deferred automations tool to list registered workspace targets (including empty ones), save disabled drafts, test and enable schedules.",
    description: "List, inspect, create disabled drafts, update saved requirements, run/test, enable/pause, delete, or cancel Automations on this PI WEB session's hosting machine, across registered workspaces, including empty targets (unambiguous current workspace first). Use list/inspect to get exact automationId and expectedRevision; never substitute a duplicate name or retry a revision conflict blindly. List discovers exact projectId/workspaceId targets. Create uses current workspace only when unambiguous, unless BOTH exact projectId/workspaceId are supplied; never infer another workspace from a path. Use draft for create, nonempty patch for update. Explicit unambiguous user requests authorize execution immediately; ask only when target/change is ambiguous. Edits pause schedules and clear successful-test status; unconfirmed work stays blocked. Reports saved definition and machine/project/workspace. Run queues a test, not completion; inspect for status/sessionId. Enable requires successful retesting of the current revision. Pause does not cancel runs. Delete archives and retains history, not a stop. Cancel requires exact automationId AND runId from inspect; cancellation intent is not confirmed settlement or force-stop. No unblock action. If unavailable, report error; no SQL, database hunting, local fallback, or skill loading. On timeout/cancellation/lost reply inspect before retrying: the action may already have been accepted, including a run or deletion.",
    // JSON Schema is intentionally dependency-free in the managed companion artifact.
    parameters: {
      type: "object", properties: {
        action: { type: "string", enum: ["list", "inspect", "create", "update", "run", "enable", "pause", "delete", "cancel"] },
        automationId: { type: "string", description: "Exact id from list; required except list/create" },
        expectedRevision: { type: "integer", minimum: 1, description: "Revision observed in list/inspect; required for update/run/enable/pause/delete" },
        runId: { type: "string", description: "Exact run id from inspect; required for cancel together with automationId" },
        projectId: { type: "string", description: "Create target only; supply together with exact workspaceId, otherwise current workspace" },
        workspaceId: { type: "string", description: "Create target only; supply together with exact projectId" },
        draft: { type: "object", properties: requirements, required: ["name", "prompt", "trigger", "model", "thinking"], additionalProperties: false },
        patch: { type: "object", properties: requirements, minProperties: 1, additionalProperties: false },
      }, required: ["action"], additionalProperties: false,
      anyOf: [
        { properties: { action: { const: "list" } } },
        { properties: { action: { const: "inspect" } }, required: ["automationId"] },
        { properties: { action: { const: "create" } }, required: ["draft"] },
        { properties: { action: { const: "update" } }, required: ["automationId", "expectedRevision", "patch"] },
        { properties: { action: { enum: ["run", "enable", "pause", "delete"] } }, required: ["automationId", "expectedRevision"] },
        { properties: { action: { const: "cancel" } }, required: ["automationId", "runId"] },
      ],
    },
    async execute(_id, params, signal, _update, ctx) {
      const input = chatRecord(params);
      if (!["list", "inspect", "create", "update", "run", "enable", "pause", "delete", "cancel"].includes(String(input["action"]))) throw new Error("Use list, inspect, create, update, run, enable, pause, delete, or cancel");
      if (!["list", "create"].includes(String(input["action"])) && typeof input["automationId"] !== "string") throw new Error("Action requires an exact automationId from list");
      const changing = !["list", "inspect"].includes(String(input["action"]));
      const uncertain = changing ? " Saving may already have occurred or another action may have been accepted; inspect/list before retrying." : "";
      let value: unknown;
      try {
        // Resolve per invocation: host revokes facades when the session/backend changes.
        const peer = createCompanionBackend(pi.events, "automations").forScope({ kind: "machine" });
        if (!peer.request) throw new Error("Automations backend has no request handler");
        value = await peer.request("manage", { ...input, currentWorkspacePath: ctx.cwd }, signal ? { signal } : {});
      } catch (error) {
        throw new Error("Automations on this hosted session's machine: " + (error instanceof Error ? error.message : String(error)) + ". No local fallback was used." + uncertain, { cause: error });
      }
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  });
}
