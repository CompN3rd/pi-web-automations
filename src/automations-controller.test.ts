import type { JsonValue, WorkspacePanelContextV5 } from "@jmfederico/pi-web/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { chatRecord } from "./browser/chat-protocol.js";
import { catalogFixture, managementSuccess } from "./browser-test-fixtures.js";
import {
  ACTIVE_POLL_INTERVAL_MS,
  IDLE_POLL_INTERVAL_MS,
  AutomationsController,
  availableThinkingLevels,
  type TimerApi,
} from "./browser/automations-controller.js";
import { AUTOMATIONS_OPERATIONS, type AutomationDefinition, type AutomationRun, type AutomationSnapshot } from "./browser/contracts.js";

const signalMatcher: unknown = expect.any(AbortSignal);

const definition: AutomationDefinition = {
  id: "automation-1", projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/repo", name: "Daily review", prompt: "Review changes", enabled: false,
  revision: 1, testedRevision: 1, trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" }, timeoutMs: 600_000, abortGraceMs: 5_000,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const run: AutomationRun = {
  id: "run-1", automationId: definition.id, automationRevision: 1, automationName: definition.name, projectId: definition.projectId, workspaceId: definition.workspaceId,
  workspacePath: definition.workspacePath, source: "manual", scheduledFor: "2026-01-01T00:00:00.000Z", status: "running", prompt: definition.prompt,
  trigger: definition.trigger, configuredModel: definition.model, configuredThinking: definition.thinking, timeoutMs: definition.timeoutMs, queuedAt: "2026-01-01T00:00:00.000Z",
};

function snapshot(runs: AutomationRun[] = []): AutomationSnapshot {
  return {
    definitions: [definition], runs,
    models: [{ provider: "anthropic", id: "sonnet", name: "Sonnet", thinkingLevels: ["low", "high"] }],
    thinkingLevels: ["off", "low", "high"], defaultTimeoutMs: 600_000, minTimeoutMs: 60_000, maxTimeoutMs: 86_400_000,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function success(value: unknown): JsonValue {
  return { contractVersion: 1, ok: true, value: json(value) };
}

function context(request: (operation: string, input: JsonValue) => Promise<JsonValue>, machineId = "local", workspaceId = "workspace-1") {
  const requestRender = vi.fn();
  const value: WorkspacePanelContextV5 = {
    navigate: vi.fn(() => Promise.resolve()),
    machine: { id: machineId, name: machineId, kind: "local" },
    workspace: { id: workspaceId, projectId: "project-1", path: "/repo", label: workspaceId, isMain: true },
    files: fileMethods(),
    peer: { request },
    catalog: catalogFixture(machineId),
    backend: { machineId, forScope: () => ({ request }) },
    host: { requestRender },
    prompt: { insertText() { return undefined; }, getText: () => "", getSelection: () => null },
    terminal: { open() { return undefined; }, runCommand: () => Promise.reject(new Error("not used")) },
  };
  return { value, requestRender };
}

describe("AutomationsController", () => {
  it("one confirmation automatically continues bounded batches and retains aggregate failure outcomes without retries", async () => {
    let current = definition;
    let calls = 0;
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>((operation, input) => {
      if (operation !== "manage") return Promise.resolve(success({ ...snapshot(), definitions: [current] }));
      if (chatRecord(input)["action"] === "archive") {
        calls++;
        current = { ...current, revision: 2, archivedAt: "2026-01-02T00:00:00Z" };
        return Promise.resolve({ ...managementSuccess, automationId: definition.id, definition: json(current), sessionArchive: calls === 1 ? {
          results: [{ sessionId: "session-A", status: "archived" }, { sessionId: "session-B", status: "uncertain", detail: "Host reply lost" }], traversalComplete: false, continuationAfter: "session-B",
        } : { results: [{ sessionId: "session-C", status: "archived" }, { sessionId: "session-D", status: "skipped-pinned" }, { sessionId: "session-E", status: "failed" }], traversalComplete: true } });
      }
      return Promise.resolve(managementSuccess);
    });
    const target = context(backend); const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value); await controller.refresh(target.value);
    controller.confirmLifecycle(target.value, definition, "archive");
    expect(controller.state(target.value).confirmation?.archiveSessions).toBeUndefined();
    controller.setArchiveSessions(target.value, true);
    await controller.applyLifecycle(target.value);
    expect(backend).toHaveBeenCalledWith("manage", { action: "archive", automationId: definition.id, expectedRevision: 1, archiveSessions: true }, { signal: signalMatcher });
    expect(backend).toHaveBeenCalledWith("manage", { action: "archive", automationId: definition.id, expectedRevision: 2, archiveSessions: true, archiveSessionAfter: "session-B" }, { signal: signalMatcher });
    expect(calls).toBe(2);
    expect(controller.state(target.value)).toMatchObject({ showArchived: true, selectedId: definition.id, sessionArchive: { summary: { traversalComplete: true, results: [
      { status: "archived" }, { status: "uncertain" }, { status: "archived" }, { status: "skipped-pinned" }, { status: "failed" },
    ] } } });
    expect(controller.state(target.value).confirmation).toBeUndefined();
    controller.confirmLifecycle(target.value, current, "archive");
    expect(controller.state(target.value).confirmation?.archiveSessions).toBeUndefined();
    await controller.setArchived(target.value, current, false);
    expect(backend).toHaveBeenCalledWith("manage", { action: "restore", automationId: definition.id, expectedRevision: current.revision });
    controller.disconnect(target.value);
  });

  it.each(["timeout", "cancelled", "blocked", "no-progress"])("stops automatic continuation on %s without infinite retries", async (reason) => {
    const archived = { ...definition, revision: 2, archivedAt: "2026-01-02T00:00:00Z" };
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>((operation) => Promise.resolve(operation === "manage"
      ? { ...managementSuccess, automationId: definition.id, definition: json(archived), sessionArchive: { results: [{ sessionId: "A", status: "deferred" }], traversalComplete: false, continuationAfter: "", ...(reason === "no-progress" ? {} : { stopReason: reason }) } }
      : success({ ...snapshot(), definitions: [archived] })));
    const target = context(backend); const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value); await controller.refresh(target.value);
    await controller.setArchived(target.value, definition, true, true);
    expect(backend.mock.calls.filter(([operation]) => operation === "manage")).toHaveLength(1);
    expect(controller.state(target.value).notice).toContain("stopped");
    controller.disconnect(target.value);
  });

  it("automatically continues an advancing budget-limited batch but stops a repeated cursor", async () => {
    const archived = { ...definition, revision: 2, archivedAt: "2026-01-02T00:00:00Z" };
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>((operation) => Promise.resolve(operation === "manage"
      ? { ...managementSuccess, automationId: definition.id, definition: json(archived), sessionArchive: { results: [{ sessionId: "A", status: "archived" }, { sessionId: "B", status: "deferred" }], traversalComplete: false, continuationAfter: "A", stopReason: "budget" } }
      : success({ ...snapshot(), definitions: [archived] })));
    const target = context(backend); const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value); await controller.refresh(target.value);
    await controller.setArchived(target.value, definition, true, true);
    const mutations = backend.mock.calls.filter(([operation]) => operation === "manage");
    expect(mutations).toHaveLength(2);
    expect(mutations[1]?.[1]).toEqual({ action: "archive", automationId: definition.id, expectedRevision: 2, archiveSessions: true, archiveSessionAfter: "A" });
    expect(controller.state(target.value).sessionArchive?.summary.results).toHaveLength(2);
    expect(controller.state(target.value).notice).toContain("without cursor progress");
    controller.disconnect(target.value);
  });

  it("keeps the archived revision fence on automatic continuation rather than adopting concurrent edits", async () => {
    let current = { ...definition, revision: 2, archivedAt: "2026-01-02T00:00:00Z" };
    let calls = 0;
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>((operation, input) => {
      if (operation !== "manage") return Promise.resolve(success({ ...snapshot(), definitions: [current] }));
      calls++;
      if (calls === 1) {
        const saved = current;
        current = { ...current, revision: 4 };
        return Promise.resolve({ ...managementSuccess, automationId: definition.id, definition: json(saved), sessionArchive: { results: [{ sessionId: "A", status: "archived" }], traversalComplete: false, continuationAfter: "A" } });
      }
      expect(chatRecord(input)["expectedRevision"]).toBe(2);
      return Promise.reject(new Error("Automation was changed by another client"));
    });
    const target = context(backend); const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value); await controller.refresh(target.value);
    await controller.setArchived(target.value, definition, true, true);
    expect(calls).toBe(2);
    expect(controller.state(target.value).sessionArchive?.summary.results).toEqual([{ sessionId: "A", status: "archived" }]);
    expect(controller.state(target.value).error).toContain("changed by another client");
    await controller.continueSessionArchive(target.value);
    expect(calls).toBe(2);
    expect(controller.state(target.value).error).toContain("revision changed");
    controller.disconnect(target.value);
  });

  it.each([1, 2])("retains unconfirmed batch %i across successful automatic polling until explicit reconciliation finishes", async (lostBatch) => {
    const archived = { ...definition, revision: 2, archivedAt: "2026-01-02T00:00:00Z" };
    const archivedSessions = new Set<string>();
    let mutations = 0;
    let reconciling = false;
    let finishReconciliation: ((value: JsonValue) => void) | undefined;
    const response = (sessionId: string, status: string, traversalComplete: boolean): JsonValue => ({ ...managementSuccess,
      automationId: definition.id, definition: json(archived), sessionArchive: { results: [{ sessionId, status }], traversalComplete,
        ...(traversalComplete ? {} : { continuationAfter: sessionId }) } });
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>((operation, input) => {
      if (operation !== "manage") return Promise.resolve(success({ ...snapshot(), definitions: [archived] }));
      mutations++;
      if (reconciling) {
        if (chatRecord(input)["archiveSessionAfter"] === undefined) return Promise.resolve(response("A", "already-archived", false));
        return new Promise((resolve) => { finishReconciliation = resolve; });
      }
      const sessionId = mutations === 1 ? "A" : "B";
      archivedSessions.add(sessionId);
      if (mutations === lostBatch) return Promise.reject(new Error("Reply lost after host admission"));
      return Promise.resolve(response(sessionId, "archived", false));
    });
    const timers = timerFixture();
    let poll: (() => void) | undefined;
    const target = context(backend);
    const controller = new AutomationsController({
      setTimeout(callback, delay) { poll = callback; return timers.api.setTimeout(callback, delay); },
      clearTimeout(handle) { timers.api.clearTimeout(handle); },
    });
    controller.connect(target.value); await controller.refresh(target.value);
    await controller.setArchived(target.value, definition, true, true);
    expect(archivedSessions.size).toBe(lostBatch);
    expect(controller.state(target.value).sessionArchive?.summary.results).toHaveLength(lostBatch - 1);
    expect(controller.state(target.value).sessionArchive?.unconfirmedBatch).toContain("Reply lost after host admission");
    poll?.(); await controller.refresh(target.value);
    expect(controller.state(target.value).error).toBeUndefined();
    expect(controller.state(target.value).sessionArchive?.unconfirmedBatch).toContain("outcomes are unconfirmed");
    expect(mutations).toBe(lostBatch);
    reconciling = true;
    const pending = controller.setArchived(target.value, archived, true, true);
    await flushMicrotasks();
    expect(controller.state(target.value).sessionArchive?.unconfirmedBatch).toContain("outcomes are unconfirmed");
    expect(finishReconciliation).toBeDefined();
    finishReconciliation?.(response("B", "already-archived", true)); await pending;
    expect(controller.state(target.value).sessionArchive?.unconfirmedBatch).toBeUndefined();
    expect(controller.state(target.value).sessionArchive?.summary.traversalComplete).toBe(true);
    controller.disconnect(target.value);
  });

  it.each(["stop", "disconnect"])("forwards %s cancellation and never starts another batch after a late reply", async (source) => {
    const archived = { ...definition, revision: 2, archivedAt: "2026-01-02T00:00:00Z" };
    let resolve: ((value: JsonValue) => void) | undefined;
    const backend = vi.fn<(operation: string, input: JsonValue, options?: { signal?: AbortSignal }) => Promise<JsonValue>>((operation) => operation === "manage"
      ? new Promise((done) => { resolve = done; }) : Promise.resolve(success({ ...snapshot(), definitions: [archived] })));
    const target = context(backend); const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value); await controller.refresh(target.value);
    const pending = controller.setArchived(target.value, definition, true, true);
    if (source === "stop") controller.stopSessionArchive(target.value); else controller.disconnect(target.value);
    expect(backend.mock.calls.find(([operation]) => operation === "manage")?.[2]?.signal?.aborted).toBe(true);
    resolve?.({ ...managementSuccess, automationId: definition.id, definition: json(archived), sessionArchive: { results: [{ sessionId: "A", status: "archived" }], traversalComplete: false, continuationAfter: "A" } });
    await pending;
    expect(backend.mock.calls.filter(([operation]) => operation === "manage")).toHaveLength(1);
    expect(controller.state(target.value).error).toContain("unconfirmed");
    controller.disconnect(target.value);
  });

  it("resets opt-in on selection and context changes and refuses continuation after concurrent restore", async () => {
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue(success(snapshot()));
    const target = context(backend); const other = context(backend, "remote", "different");
    const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value); await controller.refresh(target.value);
    controller.confirmLifecycle(target.value, definition, "archive"); controller.setArchiveSessions(target.value, true);
    controller.selectDefinition(target.value, definition.id);
    expect(controller.state(target.value).confirmation).toBeUndefined();
    controller.confirmLifecycle(target.value, definition, "archive"); controller.setArchiveSessions(target.value, true);
    controller.connect(other.value); await controller.refresh(other.value);
    expect(controller.state(target.value).confirmation).toBeUndefined();
    controller.connect(target.value); await controller.refresh(target.value);
    controller.state(target.value).sessionArchive = { automationId: definition.id, summary: { results: [], traversalComplete: false, continuationAfter: "session" } };
    await controller.continueSessionArchive(target.value);
    expect(controller.state(target.value).error).toContain("no longer archived");
    expect(backend.mock.calls.some(([operation]) => operation === "manage")).toBe(false);
    controller.disconnect(target.value);
  });

  it("pins initial selection across reordered refreshes and reconciles only when it leaves the view", async () => {
    const second = { ...definition, id: "automation-2", name: "Other review" };
    const archived = { ...definition, id: "archived", archivedAt: "2026-01-02T00:00:00Z" };
    const earlier = { ...definition, id: "earlier", name: "A new review" };
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue(success({ ...snapshot(), definitions: [definition, second, archived] }));
    const target = context(backend);
    const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value);
    await controller.refresh(target.value);
    expect(controller.state(target.value).selectedId).toBe(definition.id);
    backend.mockResolvedValue(success({ ...snapshot(), definitions: [earlier, second, { ...definition, name: "Z renamed" }, archived] }));
    await controller.refresh(target.value);
    expect(controller.state(target.value).selectedId).toBe(definition.id);
    backend.mockResolvedValue(success({ ...snapshot(), definitions: [earlier, second, archived] }));
    await controller.refresh(target.value);
    expect(controller.state(target.value).selectedId).toBe(earlier.id);
    controller.selectDefinition(target.value, second.id);
    await controller.refresh(target.value);
    expect(controller.state(target.value).selectedId).toBe(second.id);
    controller.showArchived(target.value, true);
    expect(controller.state(target.value).selectedId).toBe(archived.id);
    backend.mockResolvedValue(success({ ...snapshot(), definitions: [earlier, second] }));
    await controller.refresh(target.value);
    expect(controller.state(target.value).selectedId).toBeUndefined();
    controller.showArchived(target.value, false);
    expect(controller.state(target.value).selectedId).toBe(earlier.id);
    controller.disconnect(target.value);
  });

  it("polls at active and idle rates, then cleans up on disconnect", async () => {
    const delays: number[] = [];
    const cleared: unknown[] = [];
    const timers: TimerApi = {
      setTimeout: (_callback, delay) => { delays.push(delay); return longTimer(() => undefined, 60_000); },
      clearTimeout: (handle) => { cleared.push(handle); clearTimeout(handle); },
    };
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue(success(snapshot([run])));
    const target = context(backend);
    const controller = new AutomationsController(timers);

    controller.connect(target.value);
    await controller.refresh(target.value);
    expect(delays.at(-1)).toBe(ACTIVE_POLL_INTERVAL_MS);

    backend.mockResolvedValue(success(snapshot()));
    await controller.refresh(target.value);
    expect(delays.at(-1)).toBe(IDLE_POLL_INTERVAL_MS);

    controller.disconnect(target.value);
    expect(cleared.length).toBeGreaterThan(0);
  });

  it("pauses while hidden and refreshes when visibility returns", async () => {
    const timers = timerFixture();
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue(success(snapshot()));
    const target = context(backend);
    const controller = new AutomationsController(timers.api);
    controller.connect(target.value);
    await controller.refresh(target.value);
    const before = backend.mock.calls.length;

    controller.visibilityChanged(target.value, false);
    expect(timers.cleared).toBeGreaterThan(0);
    controller.visibilityChanged(target.value, true);
    await controller.refresh(target.value);
    expect(backend.mock.calls.length).toBeGreaterThan(before);
  });

  it("starts a fresh snapshot and resumes polling when reconnecting during a stale request", async () => {
    const responses: ((value: JsonValue) => void)[] = [];
    const backend = vi.fn(() => new Promise<JsonValue>((resolve) => { responses.push(resolve); }));
    const target = context(backend);
    const timers = timerFixture();
    const controller = new AutomationsController(timers.api);

    controller.connect(target.value);
    controller.disconnect(target.value);
    controller.connect(target.value);
    expect(backend).toHaveBeenCalledTimes(2);

    responses[1]?.(success(snapshot()));
    await flushMicrotasks();
    expect(controller.state(target.value)).toMatchObject({ loading: false, snapshot: { runs: [] } });
    expect(timers.scheduled.at(-1)).toBe(IDLE_POLL_INTERVAL_MS);

    responses[0]?.(success(snapshot([run])));
    await flushMicrotasks();
    expect(controller.state(target.value).snapshot?.runs).toEqual([]);
  });

  it("fences an old machine response after the target changes", async () => {
    let resolveOld: ((value: JsonValue) => void) | undefined;
    const oldBackend = vi.fn(() => new Promise<JsonValue>((resolve) => { resolveOld = resolve; }));
    const newBackend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue(success(snapshot()));
    const oldTarget = context(oldBackend, "old");
    const newTarget = context(newBackend, "new");
    const controller = new AutomationsController(timerFixture().api);

    controller.connect(oldTarget.value);
    controller.connect(newTarget.value);
    await controller.refresh(newTarget.value);
    resolveOld?.(success(snapshot([run])));
    await Promise.resolve(); await Promise.resolve();

    expect(controller.state(oldTarget.value).snapshot).toBeUndefined();
    expect(controller.state(newTarget.value).snapshot?.runs).toEqual([]);
  });

  it("uses shared management with exact target, revision and cancellation identity for every mutation", async () => {
    const calls: [string, JsonValue][] = [];
    const backend = vi.fn((operation: string, input: JsonValue): Promise<JsonValue> => {
      calls.push([operation, input]);
      if (operation === AUTOMATIONS_OPERATIONS.snapshot) return Promise.resolve(success(snapshot()));
      return Promise.resolve(managementSuccess);
    });
    const target = context(backend);
    const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value);
    await controller.refresh(target.value);

    controller.beginCreate(target.value);
    controller.updateEditor(target.value, { name: "New", prompt: "Do it" });
    await controller.saveEditor(target.value);
    controller.beginEdit(target.value, definition);
    controller.updateEditor(target.value, { prompt: "Changed" });
    await controller.saveEditor(target.value);
    await controller.runNow(target.value, definition);
    await controller.setEnabled(target.value, definition, true);
    await controller.delete(target.value, definition);
    await controller.cancelRun(target.value, run);

    const mutations = calls.filter(([operation]) => operation !== AUTOMATIONS_OPERATIONS.snapshot);
    expect(mutations.map(([operation]) => operation)).toEqual(Array<string>(6).fill("manage"));
    expect(mutations[0]?.[1]).toEqual({ action: "create", projectId: "project-1", workspaceId: "workspace-1", draft: { name: "New", prompt: "Do it", trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" }, timeoutMs: 600_000 } });
    expect(mutations[1]?.[1]).toMatchObject({ action: "update", automationId: "automation-1", expectedRevision: 1, patch: { description: "", prompt: "Changed" } });
    expect(mutations[2]?.[1]).toEqual({ action: "run", automationId: "automation-1", expectedRevision: 1 });
    expect(mutations[3]?.[1]).toEqual({ action: "enable", automationId: "automation-1", expectedRevision: 1 });
    expect(mutations[4]?.[1]).toEqual({ action: "delete", automationId: "automation-1", expectedRevision: 1 });
    expect(mutations[5]?.[1]).toEqual({ action: "cancel", automationId: "automation-1", runId: "run-1" });
    for (const [, input] of mutations) expect(JSON.stringify(input)).not.toMatch(/workspacePath|machine|cwd/u);
    expect(target.requestRender).toHaveBeenCalled();
  });

  it("invalidates an older snapshot before refreshing after a mutation", async () => {
    let resolveStale: ((value: JsonValue) => void) | undefined;
    let snapshotCalls = 0;
    const updated = { ...definition, name: "Updated" };
    const backend = vi.fn((operation: string): Promise<JsonValue> => {
      if (operation === "manage") return Promise.resolve(managementSuccess);
      snapshotCalls += 1;
      if (snapshotCalls === 1) return Promise.resolve(success(snapshot()));
      if (snapshotCalls === 2) return new Promise((resolve) => { resolveStale = resolve; });
      return Promise.resolve(success({ ...snapshot(), definitions: [updated] }));
    });
    const target = context(backend);
    const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value);
    await controller.refresh(target.value);

    void controller.refresh(target.value);
    await controller.runNow(target.value, definition);
    expect(controller.state(target.value).snapshot?.definitions[0]?.name).toBe("Updated");

    resolveStale?.(success(snapshot()));
    await flushMicrotasks();
    expect(controller.state(target.value).snapshot?.definitions[0]?.name).toBe("Updated");
  });

  it("uses the server default timeout fallback before the first snapshot loads", () => {
    const target = context(() => new Promise(() => undefined));
    const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value);
    controller.beginCreate(target.value);
    expect(controller.state(target.value).editor?.timeoutMs).toBe(3_600_000);
  });

  it("surfaces domain and malformed response errors", async () => {
    const domainBackend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue({ contractVersion: 1, ok: false, error: { code: "conflict", message: "revision changed" } });
    const domainTarget = context(domainBackend);
    const controller = new AutomationsController(timerFixture().api);
    controller.connect(domainTarget.value);
    await controller.refresh(domainTarget.value);
    expect(controller.state(domainTarget.value).error).toBe("revision changed");

    const malformedTarget = context(() => Promise.resolve({ ok: true, value: null }));
    controller.connect(malformedTarget.value);
    await controller.refresh(malformedTarget.value);
    expect(controller.state(malformedTarget.value).error).toContain("Invalid Automations backend response");
  });

  it("discovers empty targets and sends both selected exact IDs on the captured machine backend", async () => {
    const backend = vi.fn((operation: string) => Promise.resolve(operation === "snapshot" ? success(snapshot()) : managementSuccess));
    const target = context(backend, "remote-1");
    const forScope = vi.spyOn(target.value.backend ?? { forScope: () => ({}) }, "forScope");
    const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value); await controller.refresh(target.value);
    controller.beginCreate(target.value); await controller.discoverTargets(target.value);
    const empty = controller.state(target.value).targets?.find((item) => item.workspaceId === "workspace-empty");
    expect(empty?.projectId).toBe("project-empty");
    expect(empty?.label).toContain("Empty workspace");
    controller.updateEditor(target.value, { name: "Empty target job", prompt: "Work", projectId: "project-empty", workspaceId: "workspace-empty" });
    await controller.saveEditor(target.value);
    expect(forScope).toHaveBeenCalledWith({ kind: "workspace", projectId: "project-1", workspaceId: "workspace-1" });
    expect(backend).toHaveBeenCalledWith("manage", expect.objectContaining({ action: "create", projectId: "project-empty", workspaceId: "workspace-empty" }));
    expect(controller.state(target.value).notice).toContain("workspace-empty");
    expect(controller.state(target.value).editor).toBeUndefined();
    controller.disconnect(target.value);
  });

  it("discards obsolete discovery and reports catalog failures without guessing another target", async () => {
    const target = context(() => Promise.resolve(success(snapshot())));
    let release: ((value: []) => void) | undefined;
    vi.spyOn(target.value.catalog.projects, "list").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value);
    const pending = controller.discoverTargets(target.value);
    controller.disconnect(target.value);
    release?.([]); await pending;
    expect(controller.state(target.value).targets).toBeUndefined();
    const failed = context(() => Promise.resolve(success(snapshot())), "remote-2");
    vi.spyOn(failed.value.catalog.projects, "list").mockRejectedValue(new Error("Remote catalog unavailable"));
    controller.connect(failed.value); controller.beginCreate(failed.value);
    await controller.discoverTargets(failed.value);
    expect(controller.state(failed.value).targetError).toContain("Remote catalog unavailable");
    expect(controller.state(failed.value).editor).toMatchObject({ projectId: "project-1", workspaceId: "workspace-1" });
    controller.disconnect(failed.value);
  });

  it("retains the editor on a rejected management mutation and does not retry it", async () => {
    const backend = vi.fn((operation: string) => operation === "snapshot" ? Promise.resolve(success(snapshot())) : Promise.reject(new Error("Target revoked")));
    const target = context(backend);
    const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value); await controller.refresh(target.value);
    controller.beginCreate(target.value); await controller.saveEditor(target.value);
    expect(controller.state(target.value).editor).toBeDefined();
    expect(controller.state(target.value).error).toContain("Target revoked");
    expect(backend.mock.calls.filter(([operation]) => operation === "manage")).toHaveLength(1);
    controller.disconnect(target.value);
  });

  it("filters thinking levels to the selected model", () => {
    expect(availableThinkingLevels(snapshot(), { mode: "fixed", provider: "anthropic", id: "sonnet" })).toEqual(["low", "high"]);
    expect(availableThinkingLevels(snapshot(), { mode: "fixed", provider: "other", id: "missing" })).toEqual(["off", "low", "high"]);
    expect(availableThinkingLevels(snapshot(), { mode: "default" })).toEqual(["off", "low", "high"]);
  });
});

function timerFixture(): { api: TimerApi; cleared: number; scheduled: number[] } {
  const fixture = {
    cleared: 0,
    scheduled: new Array<number>(),
    api: {
      setTimeout: (callback: () => void, delay: number) => {
        fixture.scheduled.push(delay);
        return longTimer(callback, 60_000 + delay);
      },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => { fixture.cleared += 1; clearTimeout(handle); },
    },
  };
  return fixture;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function longTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, delay);
  handle.unref();
  return handle;
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, json(child)]));
  throw new Error("not JSON");
}

function fileMethods(): WorkspacePanelContextV5["files"] {
  const unused = (): Promise<never> => Promise.reject(new Error("not used"));
  return { readFile: unused, listFiles: unused, writeFile: unused, deleteFile: unused, moveFile: unused };
}
