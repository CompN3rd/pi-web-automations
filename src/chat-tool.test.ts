import { validateToolArguments, type Tool } from "@earendil-works/pi-ai";
import { renderToolSignature } from "@earendil-works/pi-codemode/declarations";
import type { JsonValue } from "@jmfederico/pi-web/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { chatRecord } from "./browser/chat-protocol.js";
import { registerAutomationChatTool } from "./chat-tool.js";

function fixture() {
  let tool: Tool | undefined;
  let exposure: string | undefined;
  let execute: ((args: unknown[]) => Promise<unknown>) | undefined;
  const request = vi.fn(() => Promise.resolve({ workspaces: [] }));
  const forScope = vi.fn(() => ({ request }));
  const emit = vi.fn((_channel: string, raw: unknown) => {
    const accept = chatRecord(raw)["accept"];
    if (typeof accept !== "function") throw new Error("Missing host discovery callback");
    Reflect.apply(accept, undefined, [() => ({ machineId: "local", forScope })]);
  });
  registerAutomationChatTool({
    on: vi.fn(), events: { emit, on: vi.fn() }, registerTool: (value) => {
      tool = { name: value.name, description: value.description, parameters: value.parameters };
      exposure = value.exposure;
      execute = async (args) => { const result: unknown = await Reflect.apply(value.execute.bind(value), value, args); return result; };
    },
  });
  if (!tool) throw new Error("Tool not registered");
  const registered = tool;
  const signal = new AbortController().signal;
  const invoke = async (input: Record<string, JsonValue>, validate = true) => {
    if (!execute) throw new Error("Missing tool execute");
    const params: unknown = validate ? validateToolArguments(registered, { type: "toolCall", id: "test", name: registered.name, arguments: input }) : input;
    const result: unknown = await execute(["test", params, signal, undefined, { cwd: "/repo" }]);
    return result;
  };
  return { tool, exposure, invoke, request, forScope, emit, signal };
}

const draft = { name: "Draft", prompt: "Work", trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" } };

describe("automations chat-tool schema and action validation", () => {
  it("renders every input through Pi codemode's actual declaration renderer", () => {
    const { tool, exposure } = fixture();
    const declaration = renderToolSignature({ name: tool.name, inputSchema: chatRecord(tool.parameters) });
    expect(exposure).toBe("deferred");
    expect(declaration).not.toContain("args: unknown");
    expect(declaration).toContain('action: "list" | "inspect" | "create" | "update" | "run" | "enable" | "pause" | "delete" | "cancel"');
    for (const field of ["automationId", "expectedRevision", "draft", "patch", "runId", "projectId", "workspaceId"]) expect(declaration).toContain(`${field}?:`);
    for (const field of ["name", "prompt", "trigger", "model", "thinking"]) expect(declaration).toContain(`${field}:`);
    expect(declaration).toContain("required for update/run/enable/pause/delete");
    expect(declaration).toContain("Required for create only");
    expect(declaration).toContain("Required for update only");
    expect(declaration).toContain("required for cancel together with automationId");
  });

  it.each([
    { action: "list" },
    { action: "inspect", automationId: "id" },
    { action: "create", draft },
    { action: "create", draft, projectId: "project", workspaceId: "workspace" },
    { action: "update", automationId: "id", expectedRevision: 1, patch: { prompt: "Edited" } },
    ...["run", "enable", "pause", "delete"].map((action) => ({ action, automationId: "id", expectedRevision: 1 })),
    { action: "cancel", automationId: "id", runId: "run" },
  ])("validates and forwards $action with exact fields to the hosted machine", async (input) => {
    const f = fixture();
    await f.invoke(input);
    expect(f.forScope).toHaveBeenCalledWith({ kind: "machine" });
    expect(f.request).toHaveBeenCalledWith("manage", { ...input, currentWorkspacePath: "/repo" }, { signal: f.signal });
    await f.invoke(input);
    expect(f.emit).toHaveBeenCalledTimes(2); // Never retain a host facade across invocations.
  });

  it.each<[Record<string, JsonValue>, string]>([
    [{ action: "inspect" }, "inspect requires automationId"],
    [{ action: "create" }, "create requires draft"],
    [{ action: "update", automationId: "id" }, "update requires expectedRevision"],
    [{ action: "update", automationId: "id", expectedRevision: 1 }, "update requires patch"],
    ...["run", "enable", "pause", "delete"].map((action): [Record<string, JsonValue>, string] => [{ action, automationId: "id" }, `${action} requires expectedRevision`]),
    [{ action: "cancel", automationId: "id" }, "cancel requires runId"],
    [{ action: "create", draft, projectId: "project" }, "BOTH exact projectId/workspaceId"],
    [{ action: "inspect", automationId: " " }, "exact automationId"],
    [{ action: "list", automationId: "id" }, "Unexpected automation list field"],
  ])("rejects action-specific input %j before backend discovery", async (input, message) => {
    const f = fixture();
    await expect(f.invoke(input)).rejects.toThrow(message);
    expect(f.emit).not.toHaveBeenCalled();
  });

  it.each([
    { action: "create", draft: { ...draft, enabled: true } },
    { action: "update", automationId: "id", expectedRevision: 0, patch: { name: "Edit" } },
    { action: "update", automationId: "id", expectedRevision: 1, patch: {} },
  ])("keeps nested schema validation for %j", async (input) => {
    const f = fixture();
    await expect(f.invoke(input)).rejects.toThrow("Validation failed");
    expect(f.emit).not.toHaveBeenCalled();
  });

  it("checks revisions and objects even when a caller bypasses schema validation", async () => {
    const f = fixture();
    for (const expectedRevision of [0, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      await expect(f.invoke({ action: "run", automationId: "id", expectedRevision }, false)).rejects.toThrow("positive safe integer");
    }
    for (const draft of [null, [], {}, "draft"]) await expect(f.invoke({ action: "create", draft }, false)).rejects.toThrow("nonempty draft");
    expect(f.emit).not.toHaveBeenCalled();
  });
});
