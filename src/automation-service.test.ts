import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundSessionLease } from "@jmfederico/pi-web/server-plugin-api";
import type { AutomationDraft, AutomationModel, AutomationUsageSnapshot } from "./server/contracts.js";
import { AutomationService, type AutomationServiceLogger } from "./server/automation-service.js";
import type { CreatedAutomationSession } from "./server/automation-session-runner.js";
import { AutomationStore } from "./server/automation-store.js";

const scope = { projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/repo" };
const model: AutomationModel = { provider: "test", id: "model", name: "Test Model", thinkingLevels: ["medium", "max"] };
const usage: AutomationUsageSnapshot = {
  scope: "root_session",
  quality: "estimated",
  tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, total: 16 },
  estimatedCostMicros: 2500,
  capturedAt: "2026-07-24T12:01:00.000Z",
};

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (error: unknown) => void;
  constructor() { this.promise = new Promise<T>((resolve, reject) => { this.resolvePromise = resolve; this.rejectPromise = reject; }); }
  resolve(value: T): void { this.resolvePromise(value); }
  reject(error: unknown): void { this.rejectPromise(error); }
}

const unusedLease: BackgroundSessionLease = {
  sessionId: "session-1",
  prompt: () => Promise.reject(new Error("unused")),
  snapshot: () => Promise.reject(new Error("unused")),
  abort: () => Promise.resolve(),
  forceStop: () => Promise.resolve(),
  release: () => Promise.resolve(),
};

class FakeRunner {
  readonly prompt = new Deferred<AutomationUsageSnapshot>();
  readonly created: CreatedAutomationSession = { sessionId: "session-1", lease: unusedLease, actualModel: model, actualThinkingLevel: "medium" };
  readonly createInputs: unknown[] = [];
  abortCalls = 0;
  forceStopCalls = 0;
  releaseCalls = 0;
  models(): AutomationModel[] { return [model]; }
  create(input: unknown, onCreated: (session: CreatedAutomationSession) => void): Promise<CreatedAutomationSession> {
    this.createInputs.push(input);
    onCreated(this.created);
    return Promise.resolve(this.created);
  }
  run(): Promise<AutomationUsageSnapshot> { return this.prompt.promise; }
  snapshot(): Promise<AutomationUsageSnapshot> { return Promise.resolve(usage); }
  abort(): Promise<void> { this.abortCalls += 1; this.prompt.reject(new Error("aborted")); return Promise.resolve(); }
  forceStop(): Promise<void> { this.forceStopCalls += 1; return Promise.resolve(); }
  release(): Promise<void> { this.releaseCalls += 1; return Promise.resolve(); }
}

function draft(patch: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    name: "Review",
    prompt: "Review the repository",
    trigger: { type: "manual" },
    model: { mode: "fixed", provider: "test", id: "model" },
    thinking: { mode: "fixed", level: "medium" },
    timeoutMs: 60_000,
    ...patch,
  };
}

const stores: AutomationStore[] = [];
function fixture(runner = new FakeRunner(), logger?: AutomationServiceLogger) {
  const store = new AutomationStore(":memory:");
  stores.push(store);
  const service = new AutomationService(store, runner, logger, () => new Date(Date.now()));
  return { store, runner, service };
}

function loggerFixture(): {
  logger: AutomationServiceLogger;
  errors: { details: Record<string, unknown>; message: string }[];
} {
  const errors: { details: Record<string, unknown>; message: string }[] = [];
  return {
    errors,
    logger: {
      info() { /* unused */ },
      warn() { /* unused */ },
      error(details, message) { errors.push({ details, message }); },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});

describe("AutomationService", () => {
  it("requires a successful manual run before enabling the exact revision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const { service, runner } = fixture();
    const automation = service.create(scope, draft());

    expect(() => service.update(automation.id, { ...scope, expectedRevision: 1, enabled: true })).toThrow("successfully before enabling");
    service.runNow(automation.id, scope, automation.revision);
    await flushMicrotasks();
    runner.prompt.resolve(usage);
    await flushMicrotasks();

    const tested = service.list(scope)[0];
    expect(runner.releaseCalls).toBe(1);
    expect(runner.createInputs).toEqual([{ projectId: scope.projectId, workspaceId: scope.workspaceId, model: automation.model, thinking: automation.thinking }]);
    expect(tested).toMatchObject({ revision: 1, testedRevision: 1, enabled: false });
    expect(service.update(automation.id, { ...scope, expectedRevision: 1, enabled: true })).toMatchObject({ enabled: true });
  });

  it("accepts max thinking and rejects levels unsupported by a fixed model", () => {
    const { service } = fixture();
    expect(service.models().thinkingLevels).toContain("max");
    expect(service.create(scope, draft({ thinking: { mode: "fixed", level: "max" } }))).toMatchObject({ thinking: { mode: "fixed", level: "max" } });
    expect(() => service.create(scope, draft({ name: "Unsupported", thinking: { mode: "fixed", level: "high" } }))).toThrow("unavailable for test/model");
  });

  it("guards stale delete and run-now revisions", () => {
    const { service } = fixture();
    const automation = service.create(scope, draft());
    expect(() => { service.runNow(automation.id, scope, 2); }).toThrow("changed by another client");
    expect(() => { service.delete(automation.id, scope, 2); }).toThrow("changed by another client");
  });

  it("persists user cancellation before asynchronously aborting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const { service, runner } = fixture();
    const automation = service.create(scope, draft());
    const queued = service.runNow(automation.id, scope, automation.revision);
    await flushMicrotasks();

    const cancelling = service.cancel(queued.id, scope);
    expect(cancelling).toMatchObject({ status: "cancelling", cancellationKind: "user" });
    await flushMicrotasks();
    expect(runner.abortCalls).toBe(1);
    expect(service.listRuns(scope)[0]).toMatchObject({ status: "cancelled", usage });
  });

  it("force-stops a run when soft abort never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const runner = new FakeRunner();
    runner.abort = () => { runner.abortCalls += 1; return new Promise<void>(() => undefined); };
    const { service } = fixture(runner);
    const automation = service.create(scope, draft());
    const queued = service.runNow(automation.id, scope, automation.revision);
    await flushMicrotasks();
    service.cancel(queued.id, scope);
    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();

    expect(runner.forceStopCalls).toBe(1);
    expect(service.listRuns(scope)[0]).toMatchObject({ status: "unknown", reason: "force_stop_unconfirmed", attempt: { forceStopped: true } });
  });

  it("starts the execution timeout only after lease acquisition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const runner = new FakeRunner();
    const acquisition = new Deferred<CreatedAutomationSession>();
    runner.create = (input, onCreated) => { runner.createInputs.push(input); return acquisition.promise.then((created) => { onCreated(created); return created; }); };
    const { service } = fixture(runner);
    const automation = service.create(scope, draft({ timeoutMs: 60_000 }));
    service.runNow(automation.id, scope, automation.revision);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.abortCalls).toBe(0);

    acquisition.resolve(runner.created);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(runner.abortCalls).toBe(1);
    expect(service.listRuns(scope)[0]).toMatchObject({ status: "timed_out", cancellationKind: "timeout" });
  });

  it("marks prompt terminal failures as failed runs", async () => {
    const { service, runner } = fixture();
    const automation = service.create(scope, draft());
    service.runNow(automation.id, scope, automation.revision);
    await flushMicrotasks();
    runner.prompt.reject(new Error("provider failed"));
    await flushMicrotasks();
    expect(service.listRuns(scope)[0]).toMatchObject({ status: "failed", error: "provider failed", reason: "execution_error" });
  });

  it("logs whole-tick failures and continues polling", async () => {
    vi.useFakeTimers();
    const log = loggerFixture();
    const { service, store } = fixture(new FakeRunner(), log.logger);
    const listDue = vi.spyOn(store, "listDueDefinitions").mockImplementationOnce(() => { throw new Error("database unavailable"); });

    service.start();
    expect(log.errors).toMatchObject([{ details: { err: { message: "database unavailable" } }, message: "automation scheduler tick failed" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listDue).toHaveBeenCalledTimes(2);
    await service.stop(0);
  });

  it("logs execution launch and release failures without unhandled rejections", async () => {
    const log = loggerFixture();
    const runner = new FakeRunner();
    runner.release = () => { runner.releaseCalls += 1; return Promise.reject(new Error("release failed")); };
    const { service, store } = fixture(runner, log.logger);
    const automation = service.create(scope, draft());
    vi.spyOn(store, "markRunStarting").mockImplementationOnce(() => { throw new Error("claim failed"); });

    service.runNow(automation.id, scope, automation.revision);
    await flushMicrotasks();
    expect(log.errors[0]?.message).toBe("automation execution launch failed");
    expect(typeof log.errors[0]?.details["runId"]).toBe("string");
    expect(log.errors[0]?.details["err"]).toEqual(new Error("claim failed"));

    service.start();
    runner.prompt.resolve(usage);
    await flushMicrotasks();
    expect(log.errors[1]?.message).toBe("automation session release failed");
    expect(typeof log.errors[1]?.details["runId"]).toBe("string");
    expect(log.errors[1]?.details["err"]).toEqual(new Error("release failed"));
    await service.stop(0);
  });

  it("does not arm polling when scheduler recovery fails", () => {
    vi.useFakeTimers();
    const { service, store } = fixture();
    const due = vi.spyOn(store, "listDueDefinitions");
    vi.spyOn(store, "recoverInterruptedRuns").mockImplementationOnce(() => { throw new Error("recovery failed"); });

    expect(() => { service.start(); }).toThrow("recovery failed");
    vi.advanceTimersByTime(5_000);
    expect(due).not.toHaveBeenCalled();
  });

  it("recovers ambiguous attempts when the scheduler starts", async () => {
    vi.useFakeTimers();
    const { service, store } = fixture();
    const automation = service.create(scope, draft());
    const run = store.createManualRun(automation, "interrupted", "2026-01-01T00:00:00.000Z");
    store.markRunStarting(run.id, "attempt-1", "2026-01-01T00:00:01.000Z");
    service.start();
    expect(store.getRun(run.id)).toMatchObject({ status: "unknown", reason: "daemon_restart" });
    await service.stop(0);
  });

  it("quiesces active leases and closes the store idempotently", async () => {
    vi.useFakeTimers();
    const { service, runner } = fixture();
    const automation = service.create(scope, draft());
    service.runNow(automation.id, scope, automation.revision);
    await flushMicrotasks();
    await service.stop(0);
    expect(runner.abortCalls).toBe(1);
    expect(runner.forceStopCalls).toBe(1);
    service.dispose();
    service.dispose();
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}
