import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHAT_REPLY, CHAT_REQUEST, chatRecord } from "./browser/chat-protocol.js";

export function registerAutomationChatTool(pi: Pick<ExtensionAPI, "on" | "events" | "registerTool">): void {
  const pending = new Set<(error: Error) => void>();
  pi.on("session_shutdown", () => {
    for (const reject of pending) reject(new Error("Automation chat session closed"));
  });
  pi.registerTool({
    name: "automations",
    label: "Automations",
    description: "Read saved Automations on this PI WEB session's selected machine, across workspaces (current workspace first). Use action=list for discovery, then action=inspect with the exact automationId for full saved requirements and recent runs. Reports machine and workspace identity. No SQL, local database fallback, or manually loaded skill needed. If unavailable, report the error; do not hunt databases. Read-only; create/edit/run are not supported by this tool yet.",
    // JSON Schema is intentionally dependency-free in the managed companion artifact.
    parameters: {
      type: "object", properties: {
        action: { type: "string", enum: ["list", "inspect"] },
        automationId: { type: "string", description: "Exact id from list; required for inspect" },
      }, required: ["action"], additionalProperties: false,
    },
    async execute(_id, params, signal) {
      const input = chatRecord(params);
      if (input["action"] !== "list" && input["action"] !== "inspect") throw new Error("Use list or inspect");
      if (input["action"] === "inspect" && typeof input["automationId"] !== "string") throw new Error("Inspect requires an exact automationId from list");
      const requestId = randomUUID();
      const value = await new Promise<unknown>((resolve, reject) => {
        const finish = (error?: Error, result?: unknown) => {
          clearTimeout(timer); unsubscribe(); signal?.removeEventListener("abort", abort); pending.delete(stop);
          if (error) reject(error); else resolve(result);
        };
        const stop = (error: Error) => { finish(error); };
        const abort = () => { finish(new Error("Automation query cancelled")); };
        const timer = setTimeout(() => { finish(new Error("Automations backend unavailable on this session's selected machine. Open/reload its PI WEB workspace chat and check the Automations plugin and companion. No local fallback was used.")); }, 5_000);
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
