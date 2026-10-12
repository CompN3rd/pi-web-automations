import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHAT_REPLY, CHAT_REQUEST, chatRecord } from "./browser/chat-protocol.js";

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
  const pending = new Set<(error: Error) => void>();
  pi.on("session_shutdown", () => {
    for (const reject of pending) reject(new Error("Automation chat session closed. If saving, inspect/list before retrying; saving may already have occurred."));
  });
  pi.registerTool({
    name: "automations",
    label: "Automations",
    description: "List, inspect, create disabled drafts, or update saved Automations requirements on this PI WEB session's selected machine, across workspaces (current first). Use list/inspect to get exact automationId and expectedRevision; never substitute a duplicate name or retry a revision conflict blindly. Create uses current workspace unless BOTH exact projectId/workspaceId are supplied; never infer another workspace from a path. Use draft for create, nonempty patch for update. Explicit unambiguous user requests authorize saving immediately; ask only when target/change is ambiguous. Edits pause schedules and clear successful-test status; unconfirmed work stays blocked. Reports saved definition and machine/project/workspace. Run/enable/delete are not supported here yet. If unavailable, report error; no SQL, database hunting, local fallback, or skill loading. On timeout/cancellation inspect before retrying: saving may already have occurred.",
    // JSON Schema is intentionally dependency-free in the managed companion artifact.
    parameters: {
      type: "object", properties: {
        action: { type: "string", enum: ["list", "inspect", "create", "update"] },
        automationId: { type: "string", description: "Exact id from list; required for inspect/update" },
        expectedRevision: { type: "integer", minimum: 1, description: "Revision observed in list/inspect; required for update" },
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
      ],
    },
    async execute(_id, params, signal) {
      const input = chatRecord(params);
      if (!["list", "inspect", "create", "update"].includes(String(input["action"]))) throw new Error("Use list, inspect, create, or update");
      if ((input["action"] === "inspect" || input["action"] === "update") && typeof input["automationId"] !== "string") throw new Error("Inspect/update requires an exact automationId from list");
      const saving = input["action"] === "create" || input["action"] === "update";
      const uncertain = saving ? " Saving may already have occurred; inspect/list before retrying." : "";
      const requestId = randomUUID();
      const value = await new Promise<unknown>((resolve, reject) => {
        const finish = (error?: Error, result?: unknown) => {
          clearTimeout(timer); unsubscribe(); signal?.removeEventListener("abort", abort); pending.delete(stop);
          if (error) reject(error); else resolve(result);
        };
        const stop = (error: Error) => { finish(error); };
        const abort = () => { finish(new Error(`Automation request cancelled.${uncertain}`)); };
        const timer = setTimeout(() => { finish(new Error("Automations backend unavailable on this session's selected machine. Open/reload its PI WEB workspace chat and check the Automations plugin and companion. No local fallback was used." + uncertain)); }, 5_000);
        pending.add(stop);
        const unsubscribe = pi.events.on(CHAT_REPLY, (data) => {
          const reply = chatRecord(data);
          if (reply["requestId"] !== requestId) return;
          if (typeof reply["error"] === "string") finish(new Error(reply["error"]));
          else finish(undefined, reply["value"]);
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted === true) { abort(); return; }
        try { pi.events.emit(CHAT_REQUEST, { requestId, ...input }); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  });
}
