// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@jmfederico/pi-web/plugin-api";
import type { PiWebHostPiSessionConnection, ServerPluginActivationContextV5, ServerPluginPeerRequestContextV5 } from "@jmfederico/pi-web/server-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatRecord } from "./browser/chat-protocol.js";
import { registerAutomationChatTool } from "./chat-tool.js";
import { AUTOMATION_REPLY, AUTOMATION_REQUEST } from "./companion-protocol.js";
import plugin from "./server-plugin.js";
import { AutomationStore } from "./server/automation-store.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

async function fixture(machineId: string, execution = false) {
  const root = mkdtempSync(join(tmpdir(), "automation-chat-"));
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }); });
  const lifetime = new AbortController();
  const context: ServerPluginActivationContextV5 = {
    apiVersion: 5, pluginId: "automations", packageRoot: root, dataDirectory: root, settings: {},
    signal: new AbortController().signal, lifetimeSignal: lifetime.signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, execFile: () => Promise.reject(new Error("unused")),
  };
  const handlers = new Map<string, Set<(data: unknown) => void | Promise<void>>>();
  const bus = {
    on(channel: string, handler: (data: unknown) => void | Promise<void>) {
      const entries = handlers.get(channel) ?? new Set(); entries.add(handler); handlers.set(channel, entries);
      return () => { entries.delete(handler); };
    },
    emit(channel: string, data: unknown) { for (const handler of handlers.get(channel) ?? []) void handler(data); },
  };
  let execute: ((args: unknown[]) => Promise<unknown>) | undefined;
  let validate: ((input: Record<string, JsonValue>) => unknown) | undefined;
  const hooks = new Map<string, () => void>();
  const api: Pick<ExtensionAPI, "on" | "events" | "registerTool"> = {
    events: bus,
    on: (name, handler) => { hooks.set(name, () => { Reflect.apply(handler, undefined, [{}, {}]); }); return () => undefined; },
    registerTool: (value) => {
      expect(value.exposure).toBe("deferred");
      expect(value.promptSnippet).toContain("discover");
      const validated: unknown = validateToolArguments(value, { type: "toolCall", id: "validation", name: value.name, arguments: { action: "list" } });
      expect(validated).toEqual({ action: "list" });
      validate = (input) => validateToolArguments(value, { type: "toolCall", id: "validation", name: value.name, arguments: input });
      expect(() => { validate?.({ action: "create", draft: { enabled: true } }); }).toThrow("Validation failed");
      expect(() => { validate?.({ action: "create" }); }).toThrow("Validation failed");
      expect(() => { validate?.({ action: "update", automationId: "id", patch: { name: "Edit" } }); }).toThrow("Validation failed");
      execute = async (args) => { const result: unknown = await Reflect.apply(value.execute.bind(value), value, args); return result; };
    },
  };
  registerAutomationChatTool(api);
  // Two host-authorized selections alias one cwd/native session, but have separate connections.
  const authority = (id: string) => ({ project: { id: `p-${id}`, name: `Project ${id}`, path: `/${id}` }, workspace: { projectId: `p-${id}`, id, label: id, path: `/${id}`, isMain: true } });
  let taskRequest: Record<string, unknown> | undefined;
  const taskHandlers = new Set<(data: unknown) => void | Promise<void>>();
  const taskSignal = new AbortController();
  const taskConnection: PiWebHostPiSessionConnection = {
    signal: taskSignal.signal, close: () => { taskSignal.abort(); },
    on: (channel, handler) => { if (channel === AUTOMATION_REPLY) taskHandlers.add(handler); return () => { taskHandlers.delete(handler); }; },
    emit: (channel, data) => {
      if (channel !== AUTOMATION_REQUEST) return;
      const request = chatRecord(data);
      if (request["operation"] === "prepare") for (const handler of taskHandlers) void handler({ requestId: request["requestId"], operation: "prepare", status: "ready", model: { provider: "test", id: "model", name: "Fixture", thinkingLevels: ["off"] }, thinkingLevel: "off" });
      if (request["operation"] === "run") taskRequest = request;
      // Cancellation deliberately does not settle until the simulated companion confirms.
    },
  };
  const finishTask = (status = "completed") => {
    for (const handler of taskHandlers) void handler({ requestId: taskRequest?.["requestId"], operation: "run", status, usage: { scope: "assistant_messages", quality: "partial", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, estimatedCostMicros: 0, capturedAt: new Date().toISOString() } });
  };
  const createSession = vi.fn((scope: { projectId: string; workspaceId: string }) => {
    if (!execution) return Promise.reject(new Error("Queries must not create sessions"));
    expect(scope).toEqual({ projectId: "p-a-other", workspaceId: "a-other" });
    return Promise.resolve({ sessionId: `task-${machineId}` });
  });
  const connect = vi.fn((selection: { projectId: string; workspaceId: string; sessionId: string }) => {
    if (execution && selection.sessionId === `task-${machineId}` && selection.workspaceId === "a-other") return Promise.resolve(taskConnection);
    throw new Error("Management must not connect to a session bus");
  });
  const resolve = vi.fn((scope: { projectId: string; workspaceId: string }) => {
    if (scope.workspaceId === "inaccessible" || scope.projectId !== `p-${scope.workspaceId}`) throw new Error("Not accessible");
    return Promise.resolve(authority(scope.workspaceId));
  });
  const targetIds = ["a-other", "z-current", "empty-other", "inaccessible"];
  const activation = await plugin.activate(context);
  await activation.start?.({ signal: context.signal, capabilities: { resolve: (capability) => capability.parse({
    "pi-sessions": { version: 1, create: createSession, run: () => Promise.reject(new Error("unused")) },
    "pi-session-events": { version: 1, connect },
    workspaces: { version: 1, resolve },
    catalog: { version: 1,
      projects: { list: () => Promise.resolve(targetIds.map((id) => authority(id).project)), get: () => Promise.reject(new Error("unused")) },
      workspaces: { list: (projectId: string) => Promise.resolve(targetIds.filter((id) => `p-${id}` === projectId).map((id) => ({ ...authority(id).workspace, ...(id === "alias" ? { path: "/z-current" } : {}) }))), get: () => Promise.reject(new Error("unused")) },
      sessions: { list: () => Promise.resolve([]), get: () => Promise.reject(new Error("unused")) },
    },
  }[capability.id]) } });
  cleanups.push(async () => { lifetime.abort(); await activation.dispose?.(context.signal); await settle(); });
  const request = async (id: string, operation: string, input: JsonValue) => {
    const scoped: ServerPluginPeerRequestContextV5 = { scope: { kind: "workspace", ...authority(id) }, operation, input, signal: new AbortController().signal };
    return activation.peer?.request?.(scoped);
  };
  const saved = [];
  for (const id of ["a-other", "z-current", "inaccessible"]) {
    const response = await request(id, "create", { contractVersion: 1, draft: { name: `${machineId}-${id}`, prompt: `Saved prompt ${machineId}-${id}`, trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" }, timeoutMs: 60000 } });
    saved.push(chatRecord(chatRecord(response)["value"]));
  }
  const query = async (params: unknown, signal = new AbortController().signal) => {
    if (!execute) throw new Error("Tool not registered");
    const result = await execute(["call", params, signal, undefined, { cwd }]);
    return chatRecord(result);
  };
  let cwd = "/z-current";
  const session = new AbortController();
  let available = true;
  bus.on("pi-web:companion-backend:discover", (raw) => {
    const data = chatRecord(raw);
    if (data["pluginId"] !== "automations") return;
    const accept = data["accept"];
    if (typeof accept !== "function") throw new Error("Missing accept");
    const backend = { machineId: "local", forScope: () => ({ request: async (operation: string, input: JsonValue, options?: { signal?: AbortSignal }) => {
      if (!available) throw new Error("Backend unavailable");
      const signal = AbortSignal.any([session.signal, lifetime.signal, ...(options?.signal ? [options.signal] : [])]);
      signal.throwIfAborted();
      const pending = Promise.resolve(activation.peer?.request?.({ scope: { kind: "machine" }, operation, input, signal }));
      return new Promise((resolve, reject) => {
        const abort = () => { reject(new Error("Host request cancelled")); };
        signal.addEventListener("abort", abort, { once: true });
        void pending.then(resolve, reject).finally(() => { signal.removeEventListener("abort", abort); });
      });
    } }) };
    Reflect.apply(accept, undefined, [() => backend]);
  });
  const close = () => { session.abort(); };
  return { request, query, connect, saved, lifetime, close, bus, hooks, resolve, validate, createSession, finishTask, targetIds,
    setCwd: (value: string) => { cwd = value; },
    unavailable: () => { available = false; },
    fixtureStore: () => { const store = new AutomationStore(join(root, "automations.sqlite")); cleanups.push(() => { store.close(); }); return store; } };
}

function expectSaveError(value: unknown, message: string) {
  const response = chatRecord(value);
  expect(response["ok"]).toBe(false);
  expect(chatRecord(response["error"])["message"]).toContain(message);
}

async function settle() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }

describe("host companion backend management boundary", () => {
  it("needs no browser binding and refuses an ambiguous cwd default", async () => {
    const f = await fixture("local");
    expect((await f.query({ action: "list" }))["details"]).toMatchObject({ currentWorkspace: { id: "z-current" } });
    expect(f.connect).not.toHaveBeenCalled();
    f.targetIds.push("alias");
    const draft = { name: "Explicit", prompt: "Work", trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" } };
    await expect(f.query({ action: "create", draft })).rejects.toThrow("ambiguous or unavailable");
    f.setCwd("/not-registered");
    await expect(f.query({ action: "create", draft })).rejects.toThrow("ambiguous or unavailable");
    expect((await f.query({ action: "create", projectId: "p-empty-other", workspaceId: "empty-other", draft }))["details"]).toMatchObject({ workspace: { id: "empty-other" } });
  });

  it.each(["local", "remote-1"])("runs/tests, enables, pauses and archives across workspaces on %s", async (machineId) => {
    const f = await fixture(machineId, true);
    const automationId = String(f.saved[0]?.["id"]);
    const target = { automationId, expectedRevision: 1 };
    for (const action of ["run", "enable", "pause", "delete"]) {
      expect(f.validate?.({ action, ...target })).toEqual({ action, ...target });
      expect(() => { f.validate?.({ action, automationId }); }).toThrow("Validation failed");
    }
    await expect(f.query({ action: "enable", ...target })).rejects.toThrow(`Automations on this hosted session's machine: Automation ${automationId}, project p-a-other, workspace a-other: Run this automation successfully before enabling`);
    await f.query({ action: "update", ...target, patch: { trigger: { type: "interval", intervalMs: 60000 } } });
    target.expectedRevision = 2;
    const queued = chatRecord((await f.query({ action: "run", ...target }))["details"]);
    expect(queued).toMatchObject({ machine: { id: "local", name: hostname() }, workspace: { id: "a-other" }, automationId, run: { automationId, status: "queued", automationRevision: 2 } });
    expect(String(queued["message"])).toContain("not completed");
    await settle();
    expect(f.createSession).toHaveBeenCalledOnce();
    expect((await f.query({ action: "inspect", automationId }))["details"]).toMatchObject({ runs: [{ status: "running", sessionId: `task-${machineId}` }] });
    await expect(f.query({ action: "delete", ...target })).rejects.toThrow();
    f.finishTask(); await settle();
    expect((await f.query({ action: "inspect", automationId }))["details"]).toMatchObject({ definition: { testedRevision: 2 }, runs: [{ status: "completed", sessionId: `task-${machineId}` }] });
    const enabled = chatRecord((await f.query({ action: "enable", ...target }))["details"]);
    expect(enabled).toMatchObject({ machine: { id: "local", name: hostname() }, workspace: { id: "a-other" }, definition: { enabled: true, revision: 2, testedRevision: 2 } });
    expect(typeof chatRecord(enabled["definition"])["nextRunAt"]).toBe("string");
    const paused = chatRecord((await f.query({ action: "pause", ...target }))["details"]);
    expect(paused).toMatchObject({ definition: { enabled: false, testedRevision: 2 } });
    expect(String(paused["message"])).toContain("does not cancel");
    const deleted = chatRecord((await f.query({ action: "delete", ...target }))["details"]);
    expect(deleted).toMatchObject({ deleted: true, automationId, workspace: { id: "a-other" } });
    expect(String(deleted["message"])).toContain("history");
    await expect(f.query({ action: "inspect", automationId })).rejects.toThrow("not found");
    expect(await f.request("a-other", "snapshot", { contractVersion: 1 })).toMatchObject({ value: { definitions: [], runs: [{ automationId, status: "completed", sessionId: `task-${machineId}` }] } });
  });

  it.each(["local", "remote-1"])("reports cancellation intent separately from settlement on %s", async (machineId) => {
    const f = await fixture(machineId, true);
    const automationId = String(f.saved[0]?.["id"]);
    const queued = chatRecord(chatRecord((await f.query({ action: "run", automationId, expectedRevision: 1 }))["details"])["run"]);
    await settle();
    const input = { action: "cancel", automationId, runId: String(queued["id"]) };
    expect(f.validate?.(input)).toEqual(input);
    expect(() => { f.validate?.({ action: "cancel", automationId }); }).toThrow("Validation failed");
    await expect(f.query({ ...input, automationId: f.saved[1]?.["id"] })).rejects.toThrow("run not found");
    const sibling = chatRecord(chatRecord((await f.query({ action: "create", projectId: "p-a-other", workspaceId: "a-other", draft: { name: "Same-workspace sibling", prompt: "Work", trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" } } }))["details"])["definition"]);
    await expect(f.query({ ...input, automationId: sibling["id"] })).rejects.toThrow("run not found");
    const intent = chatRecord((await f.query(input))["details"]);
    expect(intent).toMatchObject({ machine: { id: "local", name: hostname() }, workspace: { id: "a-other" }, run: { status: "cancelling", sessionId: `task-${machineId}`, attempt: { forceStopped: false } } });
    expect(String(intent["message"])).toContain("not a force-stop");
    expect((await f.query({ action: "inspect", automationId }))["details"]).toMatchObject({ runs: [{ status: "cancelling" }] });
    f.finishTask("cancelled"); await settle();
    expect((await f.query({ action: "inspect", automationId }))["details"]).toMatchObject({ definition: { enabled: false }, runs: [{ status: "cancelled", sessionId: `task-${machineId}`, attempt: { forceStopped: false } }] });
    expect((await f.query(input))["details"]).toMatchObject({ run: { status: "cancelled" } });
    await expect(f.query({ action: "enable", automationId, expectedRevision: 1 })).rejects.toThrow("successfully before enabling");
  });

  it.each(["inspect", "update", "run", "enable", "pause", "delete", "cancel"])("resolves only the stored target workspace for %s", async (action) => {
    const f = await fixture("remote-1");
    const original = f.resolve.getMockImplementation(); if (!original) throw new Error("Missing resolver");
    f.resolve.mockClear();
    f.resolve.mockImplementation((scope) => scope.workspaceId === "a-other" ? original(scope) : new Promise(() => undefined));
    const automationId = String(f.saved[0]?.["id"]);
    const input = { action, automationId, expectedRevision: 1, ...(action === "update" ? { patch: { prompt: "Updated promptly" } } : {}), ...(action === "cancel" ? { runId: "missing-run" } : {}) };
    // Inspect has no revision field; use its strict request shape.
    const request = action === "inspect" ? { action, automationId } : action === "cancel" ? { action, automationId, runId: "missing-run" } : input;
    if (action === "enable") await expect(f.query(request)).rejects.toThrow("successfully before enabling");
    else if (action === "cancel") await expect(f.query(request)).rejects.toThrow("run not found");
    else await f.query(request);
    expect(f.resolve).toHaveBeenCalled();
    expect(f.resolve.mock.calls.every(([scope]) => scope.projectId === "p-a-other" && scope.workspaceId === "a-other")).toBe(true);
    f.resolve.mockClear();
    await expect(f.query({ action: "inspect", automationId: "missing-id" })).rejects.toThrow("not found");
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it("cancels queued work without execution and rejects action after connection closure", async () => {
    const f = await fixture("remote-1");
    const store = f.fixtureStore(); const automationId = String(f.saved[0]?.["id"]);
    const definition = store.getDefinition(automationId); if (!definition) throw new Error("Missing fixture");
    const queued = store.createManualRun(definition, "queued-only", new Date().toISOString());
    expect((await f.query({ action: "cancel", automationId, runId: queued.id }))["details"]).toMatchObject({ run: { status: "cancelled" } });
    expect(f.createSession).not.toHaveBeenCalled();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.resolve.getMockImplementation(); if (!original) throw new Error("Missing resolver");
    let resolutions = 0;
    f.resolve.mockImplementation(async (scope) => {
      if (scope.workspaceId === "a-other" && ++resolutions === 1) await gate;
      return original(scope);
    });
    const abort = new AbortController();
    const pending = f.query({ action: "delete", automationId, expectedRevision: 1 }, abort.signal);
    await settle(); f.close(); abort.abort();
    await expect(pending).rejects.toThrow("another action may have been accepted");
    release?.(); await settle();
    expect(store.getDefinition(automationId)).toMatchObject({ revision: 1 });
  });

  it.each(["run", "enable", "pause", "delete", "cancel"])("re-resolves action authority and rejects malformed/stale %s requests", async (action) => {
    const f = await fixture("remote-1");
    const automationId = String(f.saved[0]?.["id"]);
    const input = { action, automationId, ...(action === "cancel" ? { runId: "exact-run" } : { expectedRevision: 1 }) };
    await expect(f.query({ ...input, workspacePath: "/untrusted" })).rejects.toThrow("Unexpected");
    await expect(f.query({ ...input, automationId: f.saved[2]?.["id"] })).rejects.toThrow("not found");
    if (action !== "cancel") {
      await expect(f.query({ ...input, expectedRevision: 99 })).rejects.toThrow("changed by another client");
      await expect(f.query({ ...input, expectedRevision: undefined })).rejects.toThrow("expectedRevision");
    }
    const original = f.resolve.getMockImplementation(); if (!original) throw new Error("Missing resolver");
    let resolutions = 0;
    f.resolve.mockImplementation((scope) => {
      if (scope.workspaceId === "a-other" && ++resolutions === 1) return Promise.reject(new Error("Target revoked before action"));
      return original(scope);
    });
    await expect(f.query(input)).rejects.toThrow("not found");
    expect(f.createSession).not.toHaveBeenCalled();
    expect(f.fixtureStore().getDefinition(automationId)).toMatchObject({ revision: 1, enabled: false });
  });
  it.each(["local", "remote-1"])("discovers empty targets and inspects only the hosting store %s", async (machineId) => {
    const f = await fixture(machineId);
    expect((await f.query({ action: "list" }))["details"]).toMatchObject({ machine: { id: "local", name: hostname() }, unavailableWorkspaces: 1, workspaces: [
      { workspace: { id: "z-current" }, definitions: [{ name: `${machineId}-z-current` }] },
      { workspace: { id: "a-other" }, definitions: [{ name: `${machineId}-a-other` }] },
      { workspace: { id: "empty-other" }, definitions: [] },
    ] });
    expect((await f.query({ action: "inspect", automationId: f.saved[0]?.["id"] }))["details"]).toMatchObject({ workspace: { id: "a-other" }, definition: { prompt: `Saved prompt ${machineId}-a-other` } });
    expect(f.connect).not.toHaveBeenCalled();
    await expect(f.query({ action: "inspect", automationId: f.saved[2]?.["id"] })).rejects.toThrow("not found");
    await expect(f.query({ action: "list", workspaceId: "inaccessible" })).rejects.toThrow("Unexpected");
  });

  it.each(["local", "remote-1"])("saves drafts and revision-guarded cross-workspace requirements on %s immediately", async (machineId) => {
    const f = await fixture(machineId);
    const draft = { name: "Chat draft", description: "Before", prompt: "Do the requested work", trigger: { type: "interval", intervalMs: 120000 }, model: { mode: "default" }, thinking: { mode: "default" }, timeoutMs: 60000 };
    const create = { action: "create", draft };
    expect(f.validate?.(create)).toEqual(create);
    const result = chatRecord((await f.query(create))["details"]);
    expect(result).toMatchObject({ saved: true, machine: { id: "local", name: hostname() }, workspace: { id: "z-current" }, definition: { ...draft, enabled: false, revision: 1 } });
    const id = chatRecord(result["definition"])["id"];
    const snapshot = chatRecord(chatRecord(await f.request("z-current", "snapshot", { contractVersion: 1 }))["value"]);
    const definitions = snapshot["definitions"]; if (!Array.isArray(definitions)) throw new Error("Missing definitions");
    expect(definitions.map(chatRecord).find((item) => item["id"] === id)).toMatchObject({ name: "Chat draft", enabled: false });
    const cross = chatRecord((await f.query({ ...create, projectId: "p-empty-other", workspaceId: "empty-other" }))["details"]);
    expect(cross).toMatchObject({ saved: true, project: { id: "p-empty-other" }, workspace: { id: "empty-other" }, definition: { workspacePath: "/empty-other", enabled: false } });
    // Stage a tested/enabled definition in this isolated store to exercise editing's safety reset.
    const store = f.fixtureStore();
    const targetId = String(f.saved[0]?.["id"]);
    const before = store.getDefinition(targetId);
    if (!before) throw new Error("Missing fixture definition");
    store.replaceDefinition({ ...before, description: "Old", enabled: true, testedRevision: 1, workspacePath: "/stale-saved-path" }, 1);
    f.resolve.mockImplementation((scope) => Promise.resolve({ project: { id: scope.projectId, name: "Resolved project", path: "/fresh" }, workspace: { projectId: scope.projectId, id: scope.workspaceId, label: "Resolved", path: "/fresh", isMain: true } }));
    const patch = { name: "Updated", description: "", prompt: "New requirements", trigger: { type: "cron", expression: "0 0 9 * * *", timeZone: "UTC" }, model: { mode: "fixed", provider: "test", id: "manual-id" }, thinking: { mode: "fixed", level: "high" }, timeoutMs: 120000 };
    const edit = { action: "update", automationId: targetId, expectedRevision: 1, patch };
    expect(f.validate?.(edit)).toEqual(edit);
    const updated = chatRecord((await f.query(edit))["details"]);
    expect(updated).toMatchObject({ saved: true, machine: { id: "local", name: hostname() }, workspace: { id: "a-other", path: "/fresh" }, definition: { name: "Updated", prompt: "New requirements", enabled: false, revision: 2, workspacePath: "/fresh", model: patch.model, thinking: patch.thinking, trigger: patch.trigger, timeoutMs: 120000 } });
    expect(chatRecord(updated["definition"])).not.toHaveProperty("testedRevision");
    expect(chatRecord(updated["definition"])).not.toHaveProperty("description");
    await expect(f.query(edit)).rejects.toThrow("changed by another client");
    expectSaveError(await f.request("a-other", "update", { contractVersion: 1, automationId: targetId, expectedRevision: 2, patch: { enabled: true } }), "successfully before enabling");
    expect(store.getDefinition(targetId)).toMatchObject({ revision: 2, enabled: false });
    expect(store.listRuns("p-a-other", "a-other")).toEqual([]);
  });

  it("refuses invalid saves, inaccessible targets and caller-supplied authority without changing saved state", async () => {
    const f = await fixture("remote-1");
    const draft = { name: "Chat draft", prompt: "Work", trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" } };
    await expect(f.query({ action: "create", projectId: "p-inaccessible", workspaceId: "inaccessible", draft })).rejects.toThrow("Not accessible");
    await expect(f.query({ action: "create", workspaceId: "a-other", draft })).rejects.toThrow("identity");
    await expect(f.query({ action: "create", workspacePath: "/other", draft })).rejects.toThrow("Unexpected");
    await expect(f.query({ action: "create", draft: { ...draft, enabled: true } })).rejects.toThrow("Unexpected");
    await expect(f.query({ action: "create", draft: { ...draft, timeoutMs: 1 } })).rejects.toThrow("Timeout must");
    await expect(f.query({ action: "create", draft: { ...draft, name: "remote-1-z-current" } })).rejects.toThrow("already exists");
    const edit = { action: "update", automationId: f.saved[0]?.["id"], expectedRevision: 1 };
    await expect(f.query({ ...edit, patch: {} })).rejects.toThrow("requirements");
    await expect(f.query({ ...edit, patch: { enabled: true } })).rejects.toThrow("enabling");
    await expect(f.query({ ...edit, expectedRevision: undefined, patch: { prompt: "No revision" } })).rejects.toThrow("expectedRevision");
    await expect(f.query({ ...edit, automationId: f.saved[2]?.["id"], patch: { prompt: "No authority" } })).rejects.toThrow("not found");
    const original = f.resolve.getMockImplementation(); if (!original) throw new Error("Missing resolver");
    let targetResolutions = 0;
    f.resolve.mockImplementation((scope) => {
      if (scope.workspaceId === "a-other" && ++targetResolutions === 1) return Promise.reject(new Error("Target revoked before save"));
      return original(scope);
    });
    await expect(f.query({ ...edit, patch: { prompt: "Revoked target" } })).rejects.toThrow("not found");
    f.resolve.mockImplementation(() => Promise.reject(new Error("Authority revoked")));
    await expect(f.query({ ...edit, patch: { prompt: "Revoked" } })).rejects.toThrow("not found");
    expect(await f.request("a-other", "snapshot", { contractVersion: 1 })).toMatchObject({ ok: true, value: { definitions: [{ prompt: "Saved prompt remote-1-a-other", revision: 1 }] } });
    expect(await f.request("z-current", "snapshot", { contractVersion: 1 })).toMatchObject({ ok: true, value: { definitions: [{ name: "remote-1-z-current", revision: 1 }] } });
  });

  it("does not save after host connection closes during workspace resolution", async () => {
    const f = await fixture("remote-1");
    const store = f.fixtureStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.resolve.getMockImplementation(); if (!original) throw new Error("Missing resolver");
    f.resolve.mockImplementation(async (scope) => { await gate; return original(scope); });
    const abort = new AbortController();
    const pending = f.query({ action: "update", automationId: f.saved[0]?.["id"], expectedRevision: 1, patch: { prompt: "Must not save" } }, abort.signal);
    f.close(); abort.abort();
    await expect(pending).rejects.toThrow("inspect/list before retrying");
    release?.(); await settle();
    expect(store.getDefinition(String(f.saved[0]?.["id"]))).toMatchObject({ revision: 1, prompt: "Saved prompt remote-1-a-other" });
  });

  it("preserves unconfirmed work blocking after a chat edit", async () => {
    const f = await fixture("local");
    const store = f.fixtureStore(); const id = String(f.saved[0]?.["id"]);
    const definition = store.getDefinition(id); if (!definition) throw new Error("Missing fixture definition");
    const run = store.createManualRun(definition, "uncertain", new Date().toISOString());
    store.markRunStarting(run.id, "attempt", new Date().toISOString());
    store.finishRun(run.id, { status: "unknown", completedAt: new Date().toISOString() });
    const saved = chatRecord((await f.query({ action: "update", automationId: id, expectedRevision: 1, patch: { prompt: "Edited but still blocked" } }))["details"]);
    expect(saved).toMatchObject({ saved: true, definition: { revision: 2, enabled: false } });
    expect(store.hasUnknownRun(id)).toBe(true);
    await expect(f.query({ action: "run", automationId: id, expectedRevision: 2 })).rejects.toThrow("unconfirmed work");
    await expect(f.query({ action: "enable", automationId: id, expectedRevision: 2 })).rejects.toThrow("unconfirmed work");
    expect((await f.query({ action: "cancel", automationId: id, runId: run.id }))["details"]).toMatchObject({ run: { status: "unknown", attempt: { forceStopped: false } } });
    expect((await f.query({ action: "pause", automationId: id, expectedRevision: 2 }))["details"]).toMatchObject({ definition: { enabled: false } });
    expectSaveError(await f.request("a-other", "run-now", { contractVersion: 1, automationId: id, expectedRevision: 2 }), "unconfirmed work");
    expectSaveError(await f.request("a-other", "update", { contractVersion: 1, automationId: id, expectedRevision: 2, patch: { enabled: true } }), "unconfirmed work");
  });

  it("fails closed when the host backend is unavailable, without another store or session fallback", async () => {
    const f = await fixture("remote-1");
    f.unavailable();
    await expect(f.query({ action: "list" })).rejects.toThrow("No local fallback");
    await expect(f.query({ action: "run", automationId: f.saved[0]?.["id"], expectedRevision: 1 })).rejects.toThrow("another action may have been accepted");
    expect(f.createSession).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
});
