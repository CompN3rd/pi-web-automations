// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonValue, WorkspaceLabelContext } from "@jmfederico/pi-web/plugin-api";
import type { PiWebHostPiSessionConnection, ServerPluginActivationContext, ServerPluginPeerRequestContext } from "@jmfederico/pi-web/server-plugin-api";
import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatLabel } from "./browser/chat-binding.js";
import { CHAT_BIND, CHAT_REPLY, CHAT_REQUEST, chatRecord } from "./browser/chat-protocol.js";
import { registerAutomationChatTool } from "./chat-tool.js";
import plugin from "./server-plugin.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { document.body.replaceChildren(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

async function fixture(machineId: string) {
  const root = mkdtempSync(join(tmpdir(), "automation-chat-"));
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }); });
  const lifetime = new AbortController();
  const context: ServerPluginActivationContext = {
    apiVersion: 3, pluginId: "automations", packageRoot: root, dataDirectory: root, settings: {},
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
  const hooks = new Map<string, () => void>();
  const api: Pick<ExtensionAPI, "on" | "events" | "registerTool"> = {
    events: bus,
    on: (name, handler) => { hooks.set(name, () => { Reflect.apply(handler, undefined, [{}, {}]); }); return () => undefined; },
    registerTool: (value) => {
      const validated: unknown = validateToolArguments(value, { type: "toolCall", id: "validation", name: value.name, arguments: { action: "list" } });
      expect(validated).toEqual({ action: "list" });
      expect(() => { validateToolArguments(value, { type: "toolCall", id: "validation", name: value.name, arguments: { action: "create" } }); }).toThrow("Validation failed");
      execute = async (args) => { const result: unknown = await Reflect.apply(value.execute.bind(value), value, args); return result; };
    },
  };
  registerAutomationChatTool(api);
  const sessions = new AbortController();
  const close = vi.fn(() => { sessions.abort(); handlers.get(CHAT_REQUEST)?.clear(); });
  const connection: PiWebHostPiSessionConnection = { ...bus, signal: sessions.signal, close };
  const authority = (id: string) => ({ project: { id: `p-${id}`, name: `Project ${id}`, path: `/${id}` }, workspace: { projectId: `p-${id}`, id, label: id, path: `/${id}`, isMain: true } });
  const connect = vi.fn((selection: { projectId: string; workspaceId: string; sessionId: string }) => {
    if (selection.sessionId !== `session-${machineId}` || selection.workspaceId !== "z-current") throw new Error("Session outside workspace or selected machine");
    return Promise.resolve(connection);
  });
  const activation = await plugin.activate(context);
  await activation.start?.({ signal: context.signal, capabilities: { resolve: (capability) => capability.parse({
    "pi-sessions": { version: 1, create: () => Promise.reject(new Error("Queries must not create sessions")), run: () => Promise.reject(new Error("unused")) },
    "pi-session-events": { version: 1, connect },
    workspaces: { version: 1, resolve: (scope: { projectId: string; workspaceId: string }) => {
      if (scope.workspaceId === "inaccessible" || scope.projectId !== `p-${scope.workspaceId}`) throw new Error("Not accessible");
      return Promise.resolve(authority(scope.workspaceId));
    } },
  }[capability.id]) } });
  cleanups.push(async () => { lifetime.abort(); await activation.dispose?.(context.signal); });
  const request = async (id: string, operation: string, input: JsonValue) => {
    const scoped: ServerPluginPeerRequestContext = { ...authority(id), operation, input, signal: new AbortController().signal };
    return activation.peer?.request?.(scoped);
  };
  const saved = [];
  for (const id of ["a-other", "z-current", "inaccessible"]) {
    const response = await request(id, "create", { contractVersion: 1, draft: { name: `${machineId}-${id}`, prompt: `Saved prompt ${machineId}-${id}`, trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" }, timeoutMs: 60000 } });
    saved.push(chatRecord(chatRecord(response)["value"]));
  }
  const query = async (params: unknown, signal = new AbortController().signal) => {
    if (!execute) throw new Error("Tool not registered");
    const result = await execute(["call", params, signal, undefined, {}]);
    return chatRecord(result);
  };
  const labelContext: WorkspaceLabelContext = {
    machine: { id: machineId, name: `Machine ${machineId}`, kind: machineId === "local" ? "local" : "remote" },
    workspace: authority("z-current").workspace,
    state: { selectedSession: { id: `session-${machineId}`, cwd: "/z-current", archived: false, pending: false } },
    host: { requestRender: vi.fn() },
    files: { readFile: vi.fn(), listFiles: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn() },
    peer: { request: (operation, input) => request("z-current", operation, input).then((value) => { if (value === undefined) throw new Error("No response"); return value; }) },
  };
  const mount = (value = labelContext) => {
    const label = chatLabel(html);
    const container = document.createElement("div"); document.body.append(container);
    const item = label.items(value)[0];
    if (item?.type !== "render") throw new Error("Expected label renderer");
    render(item.render(), container);
    return container;
  };
  return { request, query, mount, connect, saved, lifetime, close, labelContext, bus, hooks };
}

async function settle() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }

describe("ordinary workspace chat application boundary", () => {
  it.each(["local", "remote-1"])("discovers and inspects only %s via label, host connection, tool and real store", async (machineId) => {
    const f = await fixture(machineId);
    const label = f.mount(); await settle();
    expect(label.textContent).toContain("ready");
    expect(f.connect).toHaveBeenCalledWith({ projectId: "p-z-current", workspaceId: "z-current", sessionId: `session-${machineId}` });
    const list = await f.query({ action: "list" });
    expect(list["details"]).toMatchObject({ machine: { id: machineId }, unavailableWorkspaces: 1, workspaces: [
      { workspace: { id: "z-current" }, definitions: [{ name: `${machineId}-z-current`, enabled: false, revision: 1 }] },
      { workspace: { id: "a-other" }, definitions: [{ name: `${machineId}-a-other` }] },
    ] });
    const inspected = await f.query({ action: "inspect", automationId: f.saved[0]?.["id"] });
    expect(inspected["details"]).toMatchObject({ workspace: { id: "a-other" }, definition: { prompt: `Saved prompt ${machineId}-a-other`, timeoutMs: 60000 }, runs: [] });
    await expect(f.query({ action: "inspect", automationId: f.saved[2]?.["id"] })).rejects.toThrow("not found");
    await expect(f.query({ action: "list", workspaceId: "inaccessible" })).rejects.toThrow("Unexpected");
    await expect(f.request("z-current", CHAT_BIND, { sessionId: "wrong-session", machineId, machineName: "wrong" })).rejects.toThrow("outside");
    const snapshot = await f.request("a-other", "snapshot", { contractVersion: 1 });
    expect(snapshot).toMatchObject({ ok: true, value: { definitions: [{ id: f.saved[0]?.["id"], prompt: `Saved prompt ${machineId}-a-other`, revision: 1 }] } });
    // Another render/heartbeat reuses one authorized subscription, including after the browser leaves.
    await f.request("z-current", CHAT_BIND, { sessionId: `session-${machineId}`, machineId, machineName: "same" });
    expect(f.connect.mock.calls.filter(([selection]) => selection.sessionId === `session-${machineId}`)).toHaveLength(1);
    label.remove();
    expect((await f.query({ action: "list" }))["details"]).toMatchObject({ machine: { id: machineId } });
    f.lifetime.abort(); await settle(); expect(f.close).toHaveBeenCalled();
  });

  it("fails closed when remote binding fails, with no local peer or database fallback", async () => {
    vi.useFakeTimers(); const f = await fixture("remote-1");
    f.connect.mockRejectedValue(new Error("Remote unavailable"));
    const label = f.mount(); await settle(); expect(label.textContent).toContain("unavailable");
    const query = f.query({ action: "list" });
    const check = expect(query).rejects.toThrow("No local fallback");
    await vi.advanceTimersByTimeAsync(5000); await check;
    expect(f.connect.mock.calls.every(([selection]) => selection.sessionId === "session-remote-1")).toBe(true);
  });

  it("does not bind pending or mismatched workspace sessions and cleans up aborted queries", async () => {
    const f = await fixture("remote-1");
    f.mount({ ...f.labelContext, state: { selectedSession: { id: "session-remote-1", cwd: "/other", pending: false, archived: false } } });
    f.mount({ ...f.labelContext, state: { selectedSession: { id: "session-remote-1", cwd: "/z-current", pending: true, archived: false } } });
    await settle(); expect(f.connect).not.toHaveBeenCalled();
    const abort = new AbortController(); const query = f.query({ action: "list" }, abort.signal);
    abort.abort(); await expect(query).rejects.toThrow("cancelled");
    f.bus.emit(CHAT_REPLY, { requestId: "late", value: "ignored" });
    const shutdown = f.query({ action: "list" });
    f.hooks.get("session_shutdown")?.();
    await expect(shutdown).rejects.toThrow("session closed");
  });
});
