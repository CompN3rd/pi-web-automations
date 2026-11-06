import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationDefinition, AutomationUsageSnapshot } from "./server/contracts.js";
import { AutomationStore } from "./server/automation-store.js";

const stores: AutomationStore[] = [];
const tempRoots: string[] = [];

function store(): AutomationStore {
  const value = new AutomationStore(":memory:");
  stores.push(value);
  return value;
}

function definition(patch: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: "automation-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    workspacePath: "/repo",
    name: "Daily review",
    prompt: "Review the repository",
    enabled: false,
    revision: 1,
    trigger: { type: "cron", expression: "0 0 9 * * *", timeZone: "UTC" },
    model: { mode: "fixed", provider: "test", id: "model", name: "Test Model" },
    thinking: { mode: "fixed", level: "medium" },
    timeoutMs: 3_600_000,
    abortGraceMs: 15_000,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    ...patch,
  };
}

afterEach(() => {
  for (const value of stores.splice(0)) value.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AutomationStore", () => {
  it("persists reversible archives separately from deletions across reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web-automation-archive-"));
    tempRoots.push(root);
    const path = join(root, "automations.sqlite");
    const first = new AutomationStore(path);
    stores.push(first);
    const automation = first.insertDefinition(definition({ enabled: true, testedRevision: 1, nextRunAt: "2026-07-24T12:00:00.000Z" }));
    const archived = first.setDefinitionArchived(automation.id, automation.projectId, automation.workspaceId, 1, true, "2026-07-24T12:01:00.000Z");
    expect(archived).toMatchObject({ enabled: false, revision: 2, testedRevision: 2, archivedAt: "2026-07-24T12:01:00.000Z" });
    first.close();
    const reopened = new AutomationStore(path);
    stores.push(reopened);
    expect(reopened.getDefinition(automation.id)).toEqual(archived);
    expect(reopened.listDefinitions(automation.projectId, automation.workspaceId)).toEqual([archived]);
    expect(reopened.listDueDefinitions("2099-01-01T00:00:00.000Z")).toEqual([]);
    expect(() => reopened.claimScheduledOccurrence(automation, undefined, automation.createdAt, "stale-schedule")).toThrow("schedule changed");
    expect(() => reopened.setDefinitionArchived(automation.id, automation.projectId, automation.workspaceId, 1, false, automation.createdAt)).toThrow("changed by another client");
    const restored = reopened.setDefinitionArchived(automation.id, automation.projectId, automation.workspaceId, 2, false, "2026-07-24T12:02:00.000Z");
    expect(restored).toMatchObject({ enabled: false, revision: 3, testedRevision: 3 });
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.nextRunAt).toBeUndefined();
    reopened.archiveDefinition(automation.id, automation.projectId, automation.workspaceId, "2026-07-24T12:03:00.000Z");
    expect(reopened.getDefinition(automation.id)).toBeUndefined();
  });

  it("opens a better-sqlite3 0.1.2 database preserving definitions, history, usage and recovery fences", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web-automation-legacy-"));
    tempRoots.push(root);
    const path = join(root, "automations.sqlite");
    copyFileSync("src/fixtures/legacy-0.1.2.sqlite", path);
    const db = new AutomationStore(path);
    stores.push(db);
    expect(db.getDefinition("legacy-completed")).toMatchObject({
      prompt: "Retain this prompt", revision: 1, testedRevision: 1, enabled: false,
      projectId: "project-legacy", workspaceId: "workspace-legacy",
    });
    expect(db.getRun("legacy-run")).toMatchObject({
      status: "completed", sessionId: "legacy-session",
      usage: { quality: "partial", estimatedCostMicros: 123, tokens: { total: 12 } },
      attempt: { id: "legacy-attempt", status: "completed", forceStopped: false },
    });
    expect(db.costStatistics("project-legacy", "workspace-legacy")).toContainEqual({
      automationId: "legacy-completed", count: 1, priced: 1, totalMicros: 123,
    });
    expect(db.recoverInterruptedRuns("2026-07-25T12:00:00.000Z")).toMatchObject([
      { id: "legacy-interrupted", status: "unknown", attempt: { status: "unknown" } },
    ]);
    const unconfirmed = db.getDefinition("legacy-unconfirmed");
    expect(unconfirmed).toBeDefined();
    if (unconfirmed === undefined) throw new Error("Missing legacy definition");
    expect(() => db.createManualRun(unconfirmed, "unsafe-retry", "2026-07-25T12:00:00.000Z")).toThrow("unconfirmed");
    db.close();
    const reopened = new AutomationStore(path);
    stores.push(reopened);
    expect(reopened.hasUnknownRun("legacy-unconfirmed")).toBe(true);
    expect(reopened.getRun("legacy-run")?.usage?.estimatedCostMicros).toBe(123);
  });

  it("enforces occurrence and overlap guards across independent connections", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web-automation-connections-"));
    tempRoots.push(root);
    const path = join(root, "automations.sqlite");
    const first = new AutomationStore(path);
    const second = new AutomationStore(path);
    stores.push(first, second);
    const at = "2026-07-24T12:00:00.000Z";
    const automation = first.insertDefinition(definition({ enabled: true, nextRunAt: at }));
    first.claimScheduledOccurrence(automation, "2026-07-25T12:00:00.000Z", at, "scheduled-first");
    expect(() => second.claimScheduledOccurrence(automation, "2026-07-25T12:00:00.000Z", at, "scheduled-second")).toThrow("schedule changed");
    expect(() => second.createManualRun(automation, "manual-overlap", at)).toThrow("active run");
    expect(second.listRuns(automation.projectId, automation.workspaceId)).toHaveLength(1);
  });

  it("aggregates costs across retained history independently of the run list limit and scope", () => {
    const db = store();
    const automation = db.insertDefinition(definition());
    const at = "2026-07-24T12:01:00.000Z";
    for (let i = 0; i < 202; i++) {
      const id = `cost-${String(i)}`;
      db.createManualRun(automation, id, at);
      db.markRunStarting(id, `attempt-${id}`, at);
      db.finishRun(id, { status: "completed", completedAt: at, ...(i === 0 ? {} : { usage: {
        scope: "root_session", quality: "estimated", capturedAt: at,
        tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 }, estimatedCostMicros: i === 1 ? 0 : 100,
      } }) });
    }
    expect(db.listRuns("project-1", "workspace-1")).toHaveLength(200);
    expect(db.costStatistics("project-1", "workspace-1")).toEqual([{ automationId: automation.id, count: 202, priced: 201, totalMicros: 20000 }]);
    expect(db.costStatistics("other", "workspace-1")).toEqual([]);
    expect(db.costStatistics("project-1", "other")).toEqual([]);
  });

  it("uses the host-selected database path without a plugin owner file", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web-automation-store-"));
    tempRoots.push(root);
    const path = join(root, "automations.sqlite");
    const durable = new AutomationStore(path);
    stores.push(durable);
    durable.insertDefinition(definition());
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.owner`)).toBe(false);
  });

  it("persists scoped definitions and rejects duplicate active names", () => {
    const db = store();
    db.insertDefinition(definition());

    expect(db.listDefinitions("project-1", "workspace-1")).toEqual([definition()]);
    expect(() => db.insertDefinition(definition({ id: "automation-2" }))).toThrow("already exists");
    expect(db.listDefinitions("other", "workspace-1")).toEqual([]);
  });

  it("guards revisions and retains immutable run snapshots", () => {
    const db = store();
    const original = db.insertDefinition(definition({ testedRevision: 1 }));
    const run = db.createManualRun(original, "run-1", "2026-07-24T12:01:00.000Z");
    const updated = { ...original, prompt: "A changed prompt", revision: 2, enabled: false, updatedAt: "2026-07-24T12:02:00.000Z" };
    delete updated.testedRevision;
    db.replaceDefinition(updated, 1);

    expect(db.getRun(run.id)).toMatchObject({ automationRevision: 1, prompt: "Review the repository" });
    expect(() => db.replaceDefinition({ ...updated, revision: 3 }, 1)).toThrow("changed by another client");
  });

  it("forbids overlap and makes cancellation idempotent", () => {
    const db = store();
    const automation = db.insertDefinition(definition());
    const run = db.createManualRun(automation, "run-1", "2026-07-24T12:01:00.000Z");

    expect(() => db.createManualRun(automation, "run-2", "2026-07-24T12:01:01.000Z")).toThrow("active run");
    expect(db.requestCancellation(run.id, "user", "2026-07-24T12:01:02.000Z")).toMatchObject({ status: "cancelled", cancellationKind: "user" });
    expect(db.requestCancellation(run.id, "user", "2026-07-24T12:01:03.000Z")).toMatchObject({ status: "cancelled", completedAt: "2026-07-24T12:01:02.000Z" });
  });

  it("preserves the first cancellation intent when user cancel and timeout race", () => {
    const db = store();
    const automation = db.insertDefinition(definition());
    db.createManualRun(automation, "run-1", "2026-07-24T12:01:00.000Z");
    db.markRunStarting("run-1", "attempt-1", "2026-07-24T12:01:01.000Z");
    expect(db.markRunStarting("run-1", "attempt-duplicate", "2026-07-24T12:01:01.500Z")).toBeUndefined();
    db.markRunRunning("run-1", {
      sessionId: "session-1",
      startedAt: "2026-07-24T12:01:02.000Z",
      deadlineAt: "2026-07-24T13:01:02.000Z",
    });

    db.requestCancellation("run-1", "user", "2026-07-24T12:01:03.000Z");
    const raced = db.requestCancellation("run-1", "timeout", "2026-07-24T12:01:04.000Z");

    expect(raced).toMatchObject({ status: "cancelling", cancellationKind: "user", reason: "user", cancelRequestedAt: "2026-07-24T12:01:03.000Z" });
  });

  it("freezes terminal root usage and ignores late terminal rewrites", () => {
    const db = store();
    const automation = db.insertDefinition(definition());
    db.createManualRun(automation, "run-1", "2026-07-24T12:01:00.000Z");
    db.markRunStarting("run-1", "attempt-1", "2026-07-24T12:01:01.000Z");
    db.markRunRunning("run-1", {
      sessionId: "session-1",
      actualModel: { provider: "test", id: "model", name: "Test Model", thinkingLevels: ["medium"] },
      actualThinkingLevel: "medium",
      startedAt: "2026-07-24T12:01:02.000Z",
      deadlineAt: "2026-07-24T13:01:02.000Z",
    });
    const usage: AutomationUsageSnapshot = {
      scope: "root_session",
      quality: "estimated",
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 17 },
      estimatedCostMicros: 1234,
      capturedAt: "2026-07-24T12:02:00.000Z",
    };

    const completed = db.finishRun("run-1", { status: "completed", completedAt: "2026-07-24T12:02:00.000Z", usage });
    db.finishRun("run-1", { status: "failed", completedAt: "2026-07-24T12:03:00.000Z", error: "late" });

    expect(db.getRun("run-1")).toEqual(completed);
    expect(completed).toMatchObject({ status: "completed", usage, attempt: { status: "completed", usage } });
    expect(db.getDefinition(automation.id)).toMatchObject({ testedRevision: automation.revision });
  });

  it("archives an unknown-only definition while preserving its history across reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web-automation-archive-"));
    tempRoots.push(root);
    const path = join(root, "automations.sqlite");
    const db = new AutomationStore(path);
    stores.push(db);
    const automation = db.insertDefinition(definition());
    db.createManualRun(automation, "unknown-run", "2026-07-24T12:01:00.000Z");
    db.markRunStarting("unknown-run", "attempt-1", "2026-07-24T12:01:01.000Z");
    db.markRunRunning("unknown-run", { sessionId: "old-session", startedAt: "2026-07-24T12:01:02.000Z", deadlineAt: "2026-07-24T13:01:02.000Z" });
    const history = db.finishRun("unknown-run", { status: "unknown", reason: "daemon_restart", error: "Unconfirmed old work", completedAt: "2026-07-24T12:02:00.000Z" });

    expect(db.hasActiveRun(automation.id)).toBe(false);
    expect(db.hasUnknownRun(automation.id)).toBe(true);
    expect(db.archiveDefinition(automation.id, automation.projectId, automation.workspaceId, "2026-07-24T12:03:00.000Z")).toBe(true);
    expect(db.getDefinition(automation.id)).toBeUndefined();
    expect(db.listDefinitions(automation.projectId, automation.workspaceId)).toEqual([]);
    expect(db.listRuns(automation.projectId, automation.workspaceId)).toEqual([history]);
    db.close();

    const reopened = new AutomationStore(path);
    stores.push(reopened);
    reopened.recoverInterruptedRuns("2026-07-24T12:04:00.000Z");
    expect(reopened.getDefinition(automation.id)).toBeUndefined();
    expect(reopened.getRun(history.id)).toEqual(history);
    expect(reopened.listDueDefinitions("2026-07-25T12:00:00.000Z")).toEqual([]);
    expect(reopened.listQueuedRuns()).toEqual([]);
  });

  it.each(["queued", "starting", "running", "cancelling"] as const)("refuses to archive genuinely %s work", (status) => {
    const db = store();
    const automation = db.insertDefinition(definition());
    db.createManualRun(automation, "active-run", "2026-07-24T12:01:00.000Z");
    if (status !== "queued") db.markRunStarting("active-run", "attempt-1", "2026-07-24T12:01:01.000Z");
    if (status === "running" || status === "cancelling") db.markRunRunning("active-run", { sessionId: "session", startedAt: "2026-07-24T12:01:02.000Z", deadlineAt: "2026-07-24T13:01:02.000Z" });
    if (status === "cancelling") db.requestCancellation("active-run", "user", "2026-07-24T12:01:03.000Z");
    expect(db.hasActiveRun(automation.id)).toBe(true);
    expect(() => db.archiveDefinition(automation.id, automation.projectId, automation.workspaceId, "2026-07-24T12:02:00.000Z")).toThrow("active run");
    expect(db.getDefinition(automation.id)).toEqual(automation);
    expect(db.getRun("active-run")).toMatchObject({ status });
  });

  it("still blocks manual and scheduled admission for unknown work", () => {
    const db = store();
    const automation = db.insertDefinition(definition());
    db.createManualRun(automation, "unknown-run", "2026-07-24T12:01:00.000Z");
    db.markRunStarting("unknown-run", "attempt-1", "2026-07-24T12:01:01.000Z");
    db.finishRun("unknown-run", { status: "unknown", completedAt: "2026-07-24T12:02:00.000Z" });
    expect(() => db.createManualRun(automation, "retry", "2026-07-24T12:03:00.000Z")).toThrow("unconfirmed");
    // Even bypassing the service's enable guard must not admit new execution.
    const due = db.replaceDefinition({ ...automation, enabled: true, nextRunAt: "2026-07-24T12:04:00.000Z" }, automation.revision);
    expect(db.claimScheduledOccurrence(due, "2026-07-25T12:04:00.000Z", "2026-07-24T12:04:00.000Z", "scheduled")).toMatchObject({ status: "skipped" });
    expect(db.listQueuedRuns()).toEqual([]);
    expect(db.getRun("unknown-run")).toMatchObject({ status: "unknown" });
  });

  it("recovers ambiguous in-flight attempts as unknown without rerunning queued work", () => {
    const db = store();
    const automation = db.insertDefinition(definition());
    db.createManualRun(automation, "running", "2026-07-24T12:01:00.000Z");
    db.markRunStarting("running", "attempt-1", "2026-07-24T12:01:01.000Z");
    const other = db.insertDefinition(definition({ id: "automation-2", name: "Other" }));
    db.createManualRun(other, "queued", "2026-07-24T12:01:00.000Z");

    expect(db.recoverInterruptedRuns("2026-07-24T12:05:00.000Z")).toMatchObject([{ id: "running", status: "unknown", reason: "daemon_restart" }]);
    expect(db.getRun("queued")).toMatchObject({ status: "queued" });
  });
});
