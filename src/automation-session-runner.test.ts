import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebHostPiSessionConnection } from "@jmfederico/pi-web/server-plugin-api";
import { AutomationExecutionUnknownError, AutomationSessionRunner } from "./server/automation-session-runner.js";
import { AUTOMATION_REPLY, AUTOMATION_REQUEST, isRecord } from "./companion-protocol.js";

const input = { projectId: "project-1", workspaceId: "workspace-1", model: { mode: "fixed", provider: "test", id: "model" }, thinking: { mode: "fixed", level: "medium" } } as const;
const usage = { scope: "root_session", quality: "estimated", tokens: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, total: 6 }, capturedAt: "2026-01-01T00:00:00.000Z" };
function fixture(options: { handshake?: boolean; connectError?: boolean } = {}) {
  const lifetime = new AbortController();
  const closed = new AbortController();
  const handlers = new Set<(data: unknown) => void | Promise<void>>();
  const requests: Record<string, unknown>[] = [];
  const reply = (data: unknown) => { for (const handler of handlers) void handler(data); };
  const connection: PiWebHostPiSessionConnection = {
    signal: closed.signal,
    on: (channel, handler) => { expect(channel).toBe(AUTOMATION_REPLY); handlers.add(handler); return () => { handlers.delete(handler); }; },
    emit: (channel, data) => {
      expect(channel).toBe(AUTOMATION_REQUEST);
      if (!isRecord(data)) throw new Error("Invalid test request");
      requests.push(data);
      if (data["operation"] === "prepare" && options.handshake !== false) reply({ ...data, status: "ready", model: { provider: "test", id: "model", name: "Test", thinkingLevels: [] }, thinkingLevel: "medium" });
    },
    close: () => { closed.abort(); },
  };
  const create = vi.fn(() => Promise.resolve({ sessionId: "session-1" }));
  const resolve = vi.fn(() => Promise.resolve({ project: { id: input.projectId, name: "Project", path: "/repo" }, workspace: { id: input.workspaceId, projectId: input.projectId, path: "/repo", label: "main", isMain: true } }));
  const runner = new AutomationSessionRunner({ version: 1, create, run: () => Promise.reject(new Error("unused")) }, {
    version: 1, connect: () => options.connectError === true ? Promise.reject(new Error("connect failed")) : Promise.resolve(connection),
  }, { version: 1, resolve }, lifetime.signal);
  return { runner, create, resolve, lifetime, closed, handlers, requests, reply };
}
afterEach(() => { vi.useRealTimers(); });

describe("AutomationSessionRunner public capabilities", () => {
  it("resolves authority, creates without private options, and subscribes before synchronous handshake", async () => {
    const f = fixture();
    expect(f.runner.models()).toEqual([]);
    const session = await f.runner.create(input, () => undefined);
    expect(f.resolve).toHaveBeenCalledWith({ projectId: input.projectId, workspaceId: input.workspaceId });
    expect(f.create).toHaveBeenCalledWith({ projectId: input.projectId, workspaceId: input.workspaceId });
    expect(f.requests[0]).toMatchObject({ operation: "prepare", model: input.model, thinking: input.thinking });
    expect(session).toMatchObject({ actualThinkingLevel: "medium", actualModel: { id: "model" } });
    const completion = f.runner.run(session, "prompt", () => usage.capturedAt);
    f.reply({ requestId: "wrong", operation: "run", status: "completed", usage });
    expect(f.handlers.size).toBe(1);
    f.reply({ requestId: session.requestId, operation: "run", status: "completed", usage });
    await expect(completion).resolves.toMatchObject({ tokens: { total: 6 } });
    expect(f.handlers.size).toBe(0);
    await f.runner.release(session);
  });
  it("preserves the published identity when connect fails", async () => {
    const f = fixture({ connectError: true });
    const created = vi.fn();
    await expect(f.runner.create(input, created)).rejects.toThrow("connect failed");
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
  });
  it("bounds a missing companion handshake and detaches listeners", async () => {
    vi.useFakeTimers();
    const f = fixture({ handshake: false });
    const pending = f.runner.create(input, () => undefined);
    const assertion = expect(pending).rejects.toThrow("No Automations companion handshake");
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(f.handlers.size).toBe(0);
    expect(f.requests).toHaveLength(1);
  });
  it.each(["connection", "lifetime"])("does not convert %s loss to completion or cancellation", async (source) => {
    const f = fixture();
    const session = await f.runner.create(input, () => undefined);
    const result = f.runner.run(session, "prompt", () => usage.capturedAt);
    const assertion = expect(result).rejects.toBeInstanceOf(AutomationExecutionUnknownError);
    (source === "connection" ? f.closed : f.lifetime).abort();
    await assertion;
    expect(f.handlers.size).toBe(0);
    expect(f.requests.map((request) => request["operation"])).toEqual(["prepare", "run"]);
  });
  it("waits for correlated settlement after cancel and never cancels later user work", async () => {
    const f = fixture();
    const session = await f.runner.create(input, () => undefined);
    const result = f.runner.run(session, "prompt", () => usage.capturedAt);
    const assertion = expect(result).rejects.toThrow("cancelled");
    const cancel = f.runner.abort(session);
    expect(f.requests.at(-1)).toMatchObject({ operation: "cancel", requestId: session.requestId });
    f.reply({ requestId: session.requestId, operation: "run", status: "cancelled", usage });
    await assertion; await cancel;
    const count = f.requests.length;
    await f.runner.abort(session);
    expect(f.requests).toHaveLength(count);
  });
  it("cancels locally before submission, without sending a user prompt", async () => {
    const f = fixture();
    const session = await f.runner.create(input, () => undefined);
    await f.runner.abort(session);
    await expect(f.runner.run(session, "prompt", () => usage.capturedAt)).rejects.toThrow("before prompt");
    expect(f.requests).toHaveLength(1);
  });
});
