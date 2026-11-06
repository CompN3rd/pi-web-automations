import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerPluginActivationContextV5, ServerPluginCapabilityResolver, ServerPluginPeerRequestContextV5 } from "@jmfederico/pi-web/server-plugin-api";
import plugin from "./server-plugin.js";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const dataDirectory = mkdtempSync(join(tmpdir(), "pi-web-automations-plugin-")); roots.push(dataDirectory);
  const lifetime = new AbortController();
  const context: ServerPluginActivationContextV5 = {
    apiVersion: 5, pluginId: "automations", packageRoot: dataDirectory, dataDirectory, settings: {},
    signal: new AbortController().signal, lifetimeSignal: lifetime.signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, execFile: () => Promise.reject(new Error("not used")),
  };
  const resolved: string[] = [];
  const capabilities: ServerPluginCapabilityResolver = { resolve: (capability) => {
    resolved.push(capability.id);
    const values: Record<string, unknown> = {
      "pi-sessions": { version: 1, create: () => Promise.resolve({ sessionId: "session-1" }), run: () => Promise.reject(new Error("unused")) },
      "pi-session-events": { version: 1, connect: () => Promise.reject(new Error("companion connection unavailable")) },
      "session-lifecycle": { version: 1, get: vi.fn(), archive: vi.fn(), restore: vi.fn(), delete: vi.fn(), pin: vi.fn(), unpin: vi.fn() },
    catalog: { version: 1, projects: { list: () => Promise.resolve([]), get: vi.fn() }, workspaces: { list: () => Promise.resolve([]), get: vi.fn() }, sessions: { list: () => Promise.resolve([]), get: vi.fn() } },
      workspaces: { version: 1, resolve: () => Promise.resolve({ project: { id: "p", name: "P", path: "/repo" }, workspace: { id: "w", projectId: "p", label: "main", path: "/repo", isMain: true } }) },
    };
    return capability.parse(values[capability.id]);
  } };
  const request: ServerPluginPeerRequestContextV5 = { scope: { kind: "workspace", project: { id: "p", name: "P", path: "/repo" }, workspace: { id: "w", projectId: "p", label: "main", path: "/repo", isMain: true } }, operation: "snapshot", input: { contractVersion: 1 }, signal: new AbortController().signal };
  return { context, capabilities, lifetime, resolved, request };
}
describe("Automations server plugin API v5 lifecycle", () => {
  it("opens only dataDirectory at start and synchronously quiesces before disposal", async () => {
    vi.useFakeTimers();
    const f = fixture(); const activation = await plugin.activate(f.context);
    expect(plugin.apiVersion).toBe(5);
    expect(plugin.requires?.map((entry) => `${entry.id}@${String(entry.version)}`)).toEqual(["pi-sessions@1", "pi-session-events@1", "workspaces@1", "catalog@1", "session-lifecycle@1"]);
    expect(existsSync(join(f.context.dataDirectory, "automations.sqlite"))).toBe(false);
    await activation.start?.({ capabilities: f.capabilities, signal: new AbortController().signal });
    expect(f.resolved).toEqual(["pi-sessions", "pi-session-events", "workspaces", "catalog", "session-lifecycle"]);
    expect(existsSync(join(f.context.dataDirectory, "automations.sqlite"))).toBe(true);
    expect(await activation.health?.(f.context.signal)).toEqual({ status: "healthy" });
    expect(await activation.peer?.request?.(f.request)).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(1);
    f.lifetime.abort();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => activation.peer?.request?.(f.request)).toThrow();
    await activation.dispose?.(f.context.signal); await activation.dispose?.(f.context.signal);
    expect(await activation.health?.(f.context.signal)).toMatchObject({ status: "degraded" });
  });
  it("serves shared management to scoped browser calls and rejects workspace-only operations at machine scope", async () => {
    const f = fixture(); const activation = await plugin.activate(f.context);
    try {
      await activation.start?.({ capabilities: f.capabilities, signal: f.context.signal });
      expect(() => activation.peer?.request?.({ ...f.request, scope: { kind: "machine" } })).toThrow("requires workspace scope");
      const draft = { name: "Shared management", prompt: "Work", trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" } };
      const created = await activation.peer?.request?.({ ...f.request, operation: "manage", input: { action: "create", draft } });
      expect(created).toMatchObject({ saved: true, project: { id: "p" }, workspace: { id: "w" }, definition: { enabled: false, revision: 1 } });
      expect(await activation.peer?.request?.(f.request)).toMatchObject({ value: { definitions: [{ name: "Shared management" }] } });
    } finally { f.lifetime.abort(); await activation.dispose?.(f.context.signal); }
  });
  it("cleans up a failed start without scheduling", async () => {
    vi.useFakeTimers(); const f = fixture(); const activation = await plugin.activate(f.context);
    await expect(async () => activation.start?.({ capabilities: { resolve: () => { throw new Error("dependency unavailable"); } }, signal: f.context.signal })).rejects.toThrow("dependency unavailable");
    expect(await activation.health?.(f.context.signal)).toMatchObject({ status: "unhealthy" });
    expect(vi.getTimerCount()).toBe(0);
    await activation.dispose?.(f.context.signal);
  });
});
