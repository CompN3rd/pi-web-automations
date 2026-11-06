import type { PluginCatalogV1, PluginSessionLifecycleV1, PluginSessionSnapshot } from "@jmfederico/pi-web/server-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionArchiver } from "./server/session-archive.js";

function fixture() {
  const snapshot: PluginSessionSnapshot = { id: "full-session-A", cwd: "/repo", archived: false, pinned: false, runtime: "idle", created: null, modified: null, archivedAt: null };
  const get = vi.fn<PluginCatalogV1["sessions"]["get"]>(() => Promise.resolve(snapshot));
  const state = vi.fn<PluginSessionLifecycleV1["get"]>(() => Promise.resolve({ sessionId: snapshot.id, pinned: false, archived: false }));
  const archive = vi.fn<PluginSessionLifecycleV1["archive"]>(() => Promise.resolve());
  const forbidden = vi.fn(() => Promise.reject(new Error("Forbidden operation")));
  const lifecycle: PluginSessionLifecycleV1 = { version: 1, get: state, archive, restore: forbidden, delete: forbidden, pin: forbidden, unpin: forbidden };
  const catalog: PluginCatalogV1 = { version: 1, projects: { list: forbidden, get: forbidden }, workspaces: { list: forbidden, get: forbidden }, sessions: { list: forbidden, get } };
  const archiver = new SessionArchiver(catalog, lifecycle);
  const caller = new AbortController();
  const lifetime = new AbortController();
  const page = vi.fn<(after?: string) => string[]>(() => [snapshot.id]);
  const batch = (after?: string, deadline = Date.now() + 8000) => archiver.batch("automation", { projectId: "project-exact", workspaceId: "workspace-exact" }, page, AbortSignal.any([caller.signal, lifetime.signal]), deadline, after);
  return { snapshot, get, state, archive, forbidden, caller, lifetime, page, batch };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); });

describe("SessionArchiver exact bounded host lifecycle operations", () => {
  it("archives an exact identity with signals and no descendant discovery", async () => {
    const f = fixture();
    expect(await f.batch()).toEqual({ results: [{ sessionId: "full-session-A", status: "archived" }], traversalComplete: true });
    expect(f.page).toHaveBeenCalledTimes(2);
    expect(f.archive).toHaveBeenCalledExactlyOnceWith({ projectId: "project-exact", workspaceId: "workspace-exact", sessionId: "full-session-A" }, { signal: f.archive.mock.calls[0]?.[1]?.signal });
    expect(f.get.mock.calls[0]).toEqual(f.state.mock.calls[0]);
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it("automatically visits multiple exact sessions once, aggregates failures, and caps each request", async () => {
    const f = fixture();
    const ids = Array.from({ length: 53 }, (_, index) => `session-${String(index).padStart(3, "0")}`);
    f.page.mockImplementation((after = "") => ids.filter((id) => id > after).slice(0, 2));
    f.get.mockImplementation((target) => Promise.resolve({ ...f.snapshot, id: target.sessionId }));
    f.state.mockImplementation((target) => Promise.resolve({ sessionId: target.sessionId, pinned: false, archived: false }));
    f.get.mockRejectedValueOnce(new Error("Missing"));
    f.archive.mockRejectedValueOnce(new Error("Reply lost"));
    const first = await f.batch();
    expect(first.results).toHaveLength(50);
    expect(first.results.slice(0, 3).map((result) => result.status)).toEqual(["failed", "uncertain", "archived"]);
    expect(first).toMatchObject({ traversalComplete: false, continuationAfter: ids[49] });
    expect(f.archive).toHaveBeenCalledTimes(49);
    const rest = await f.batch(first.continuationAfter);
    expect(rest.results).toHaveLength(3);
    expect(rest.traversalComplete).toBe(true);
    expect(f.archive).toHaveBeenCalledTimes(52);
    expect(new Set(f.archive.mock.calls.map(([target]) => target.sessionId)).size).toBe(52);
  });
  it("returns aggregate progress before its request deadline without retrying the deferred identity", async () => {
    vi.useFakeTimers(); const f = fixture();
    const ids = ["A", "B", "C", "D"];
    f.page.mockImplementation((after = "") => ids.filter((id) => id > after).slice(0, 2));
    f.get.mockImplementation((target) => Promise.resolve({ ...f.snapshot, id: target.sessionId }));
    f.state.mockImplementation((target) => Promise.resolve({ sessionId: target.sessionId, pinned: false, archived: false }));
    f.archive.mockImplementation(() => { vi.setSystemTime(Date.now() + 1000); return Promise.resolve(); });
    const summary = await f.batch(undefined, Date.now() + 2000);
    expect(summary).toEqual({ results: [{ sessionId: "A", status: "archived" }, { sessionId: "B", status: "archived" }, { sessionId: "C", status: "deferred", detail: "Session archive request budget exhausted; remaining sessions not attempted" }], traversalComplete: false, continuationAfter: "B", stopReason: "budget" });
    expect(f.archive.mock.calls.map(([target]) => target.sessionId)).toEqual(["A", "B"]);
  });
  it("keeps aggregate results and stops all subsequent mutations when cancelled between sessions", async () => {
    const f = fixture();
    f.page.mockImplementation((after = "") => ["A", "B", "C"].filter((id) => id > after).slice(0, 2));
    f.get.mockImplementation((target) => {
      if (target.sessionId === "B") f.caller.abort(new Error("Stopped"));
      return Promise.resolve({ ...f.snapshot, id: target.sessionId });
    });
    f.state.mockImplementation((target) => Promise.resolve({ sessionId: target.sessionId, pinned: false, archived: false }));
    expect(await f.batch()).toMatchObject({ results: [{ sessionId: "A", status: "archived" }, { sessionId: "B", status: "deferred" }], traversalComplete: false, continuationAfter: "A", stopReason: "cancelled" });
    expect(f.archive).toHaveBeenCalledTimes(1);
  });
  it.each(["already-archived", "skipped-pinned", "skipped-busy"])("reports %s without mutation", async (status) => {
    const f = fixture();
    if (status === "already-archived") f.state.mockResolvedValue({ sessionId: f.snapshot.id, archived: true, pinned: false });
    if (status === "skipped-pinned") f.state.mockResolvedValue({ sessionId: f.snapshot.id, archived: false, pinned: true });
    if (status === "skipped-busy") f.get.mockResolvedValue({ ...f.snapshot, runtime: "busy" });
    expect(await f.batch()).toMatchObject({ results: [{ status }] });
    expect(f.archive).not.toHaveBeenCalled();
  });
  it("treats busy runtime and catalog pin metadata conservatively", async () => {
    const f = fixture();
    f.get.mockResolvedValue({ ...f.snapshot, runtime: "busy" });
    expect(await f.batch()).toMatchObject({ results: [{ status: "skipped-busy" }] });
    f.get.mockResolvedValue({ ...f.snapshot, pinned: true });
    expect(await f.batch()).toMatchObject({ results: [{ status: "skipped-pinned" }] });
  });
  it("reports missing/inaccessible sessions and mismatched host identities as failures, not success", async () => {
    const f = fixture();
    f.get.mockRejectedValueOnce(new Error("Session missing"));
    expect(await f.batch()).toMatchObject({ results: [{ status: "failed", detail: "Session missing" }] });
    f.state.mockResolvedValue({ sessionId: "wrong-id", archived: true, pinned: false });
    expect(await f.batch()).toMatchObject({ results: [{ status: "failed", detail: "Host returned a different session identity" }] });
    expect(f.archive).not.toHaveBeenCalled();
  });
  it("fences a concurrent restore/delete before mutation", async () => {
    const f = fixture();
    f.state.mockImplementationOnce(() => {
      f.page.mockImplementation(() => { throw new Error("Automation restored or deleted"); });
      return Promise.resolve({ sessionId: f.snapshot.id, archived: false, pinned: false });
    });
    expect(await f.batch()).toMatchObject({ results: [{ status: "failed", detail: "Automation restored or deleted" }] });
    expect(f.archive).not.toHaveBeenCalled();
  });
  it("reports ambiguous mutation failure, then reconciles state on explicit retry without resending archive", async () => {
    const f = fixture();
    f.archive.mockRejectedValueOnce(new Error("Reply lost"));
    expect(await f.batch()).toMatchObject({ results: [{ status: "uncertain" }] });
    f.state.mockResolvedValue({ sessionId: f.snapshot.id, archived: true, pinned: false });
    expect(await f.batch()).toMatchObject({ results: [{ status: "already-archived" }] });
    expect(f.archive).toHaveBeenCalledTimes(1);
  });
  it("bounds a hung mutation and serializes retries until the admitted operation settles", async () => {
    vi.useFakeTimers(); const f = fixture();
    let resolve: (() => void) | undefined;
    f.archive.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const pending = f.batch(); await settle();
    await expect(f.batch()).rejects.toThrow("still in flight");
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toMatchObject({ results: [{ status: "uncertain", detail: "Session operation timed out; reconcile before retry" }] });
    expect(f.archive.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expect(f.batch()).rejects.toThrow("still in flight");
    resolve?.(); await settle();
    f.state.mockResolvedValue({ sessionId: f.snapshot.id, archived: true, pinned: false });
    expect(await f.batch()).toMatchObject({ results: [{ status: "already-archived" }] });
    expect(f.archive).toHaveBeenCalledTimes(1);
  });
  it.each(["caller", "shutdown"])("stops new work on %s cancellation during a read", async (source) => {
    const f = fixture();
    let resolve: ((value: typeof f.snapshot) => void) | undefined;
    f.get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = f.batch(); await settle(); (source === "shutdown" ? f.lifetime : f.caller).abort(new Error("Disposed"));
    expect(await pending).toMatchObject({ results: [{ status: "deferred" }], continuationAfter: "", traversalComplete: false });
    resolve?.(f.snapshot); await settle();
    expect(f.archive).not.toHaveBeenCalled(); expect(f.state).not.toHaveBeenCalled();
  });
  it("times out a catalog read without letting its late completion start a mutation", async () => {
    vi.useFakeTimers(); const f = fixture();
    let resolve: ((value: typeof f.snapshot) => void) | undefined;
    f.get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = f.batch(); await settle(); await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toMatchObject({ results: [{ status: "deferred" }], continuationAfter: "", traversalComplete: false });
    resolve?.(f.snapshot); await settle();
    expect(f.archive).not.toHaveBeenCalled(); expect(f.state).not.toHaveBeenCalled();
    expect(await f.batch()).toMatchObject({ results: [{ status: "archived" }] });
  });

  it("returns deferred without advancing cursor when budget exhausted, or complete for absent IDs", async () => {
    const f = fixture();
    expect(await f.batch("previous-id", Date.now())).toMatchObject({ results: [{ status: "deferred" }], continuationAfter: "previous-id" });
    expect(f.archive).not.toHaveBeenCalled();
    f.page.mockReturnValue([]);
    expect(await f.batch()).toEqual({ results: [], traversalComplete: true });
  });
});
