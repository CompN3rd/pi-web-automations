import { createCompanionBackend } from "@jmfederico/pi-web/server-plugin-api";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateAutomationAction } from "./browser/chat-protocol.js";

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
    description: "List, inspect, create disabled drafts, update saved requirements, run/test, enable/pause, archive/restore, delete, or cancel Automations on this PI WEB session's hosting machine, across registered workspaces, including empty targets (unambiguous current workspace first). Use list/inspect to get exact automationId and expectedRevision; never substitute a duplicate name or retry a revision conflict blindly. List without IDs discovers targets machine-wide; list with BOTH exact projectId/workspaceId reads only that workspace, without enumerating unrelated targets. Prefer exact-scope list when IDs are known (for example from the workspace panel URL). Requested-scope authority failure is an error, not an empty list. Never guess IDs from paths. Create uses current workspace only when unambiguous, unless BOTH exact projectId/workspaceId are supplied; never infer another workspace from a path. Use draft for create, nonempty patch for update. Explicit unambiguous user requests authorize execution immediately; ask only when target/change is ambiguous. Edits pause schedules and clear successful-test status; unconfirmed work stays blocked. Reports saved definition and machine/project/workspace. Run queues a test, not completion; inspect for status/sessionId. Enable requires successful retesting of the current revision. Pause does not cancel runs. Archive pauses scheduling and hides the definition in the Archived view; restore leaves it paused. Delete removes the definition from management but retains run history. Session archive/delete is not supported by the host plugin API; sessions are retained. Neither action stops work. Cancel requires exact automationId AND runId from inspect; cancellation intent is not confirmed settlement or force-stop. No unblock action. If unavailable, report error; no SQL, database hunting, local fallback, or skill loading. On timeout/cancellation/lost reply inspect before retrying: the action may already have been accepted, including a run or deletion.",
    // Keep the root flat: Pi's codemode renderer ignores sibling properties/required
    // when anyOf/oneOf/allOf is present. Action requirements are checked in execute
    // and again by the backend, rather than reporting unrelated union failures.
    parameters: {
      type: "object", properties: {
        action: { type: "string", enum: ["list", "inspect", "create", "update", "run", "enable", "pause", "archive", "restore", "delete", "cancel"] },
        automationId: { type: "string", description: "Exact id from list; required except list/create" },
        expectedRevision: { type: "integer", minimum: 1, description: "Revision observed in list/inspect; required for update/run/enable/pause/archive/restore/delete" },
        runId: { type: "string", description: "Exact run id from inspect; required for cancel together with automationId" },
        projectId: { type: "string", description: "List/create target; supply BOTH exact projectId/workspaceId. List without IDs is machine-wide; create without IDs uses current workspace" },
        workspaceId: { type: "string", description: "List/create target; supply together with exact projectId. Scoped list never enumerates unrelated workspaces" },
        draft: { type: "object", description: "Required for create only: disabled draft requirements", properties: requirements, required: ["name", "prompt", "trigger", "model", "thinking"], additionalProperties: false },
        patch: { type: "object", description: "Required for update only: nonempty saved requirements to change", properties: requirements, minProperties: 1, additionalProperties: false },
      }, required: ["action"], additionalProperties: false,
    },
    async execute(_id, params, signal, _update, ctx) {
      const input = validateAutomationAction(params);
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
