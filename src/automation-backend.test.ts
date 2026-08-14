import { describe, expect, it, vi } from "vitest";
import type { WorkspaceBackendRequestContext } from "@jmfederico/pi-web/server-plugin-api";
import { AUTOMATIONS_OPERATIONS } from "./browser/contracts.js";
import { AutomationBackend } from "./server/automation-backend.js";
import { AutomationService } from "./server/automation-service.js";
import type { AutomationModel, AutomationUsageSnapshot } from "./server/contracts.js";
import type { CreatedAutomationSession } from "./server/automation-session-runner.js";
import { AutomationStore } from "./server/automation-store.js";

const model: AutomationModel = { provider: "test", id: "model", name: "Test", thinkingLevels: ["medium"] };
const usage: AutomationUsageSnapshot = { scope: "root_session", quality: "estimated", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, capturedAt: "2026-01-01T00:00:00.000Z" };

class PendingRunner {
  readonly createInputs: unknown[] = [];
  models(): AutomationModel[] { return [model]; }
  create(input: unknown): Promise<CreatedAutomationSession> { this.createInputs.push(input); return new Promise(() => undefined); }
  run(): Promise<AutomationUsageSnapshot> { return Promise.resolve(usage); }
  snapshot(): Promise<AutomationUsageSnapshot> { return Promise.resolve(usage); }
  abort(): Promise<void> { return Promise.resolve(); }
  forceStop(): Promise<void> { return Promise.resolve(); }
  release(): Promise<void> { return Promise.resolve(); }
}

function context(operation: string, input: WorkspaceBackendRequestContext["input"]): WorkspaceBackendRequestContext {
  return {
    project: { id: "project-1", name: "Project", path: "/registered" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/authoritative", label: "main", isMain: true },
    operation,
    input,
    signal: new AbortController().signal,
  };
}

function draft() {
  return { name: "Review", prompt: "Review", trigger: { type: "manual" as const }, model: { mode: "fixed" as const, provider: "test", id: "model" }, thinking: { mode: "fixed" as const, level: "medium" }, timeoutMs: 60_000 };
}

describe("AutomationBackend", () => {
  it("rejects caller-supplied scope and unknown fields in its package envelope", async () => {
    const store = new AutomationStore(":memory:");
    const service = new AutomationService(store, new PendingRunner());
    const backend = new AutomationBackend(() => service);
    await expect(backend.request(context(AUTOMATIONS_OPERATIONS.create, { contractVersion: 1, draft: { ...draft(), cwd: "/evil" } }))).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid-input", message: "Unexpected input field: cwd" },
    });
    await expect(backend.request(context(AUTOMATIONS_OPERATIONS.snapshot, { contractVersion: 1, projectId: "other" }))).resolves.toMatchObject({ ok: false, error: { code: "invalid-input" } });
    store.close();
  });

  it("uses authoritative context scope and returns queued runs without awaiting lease acquisition", async () => {
    const store = new AutomationStore(":memory:");
    const runner = new PendingRunner();
    const service = new AutomationService(store, runner);
    const backend = new AutomationBackend(() => service);
    const created = await backend.request(context(AUTOMATIONS_OPERATIONS.create, { contractVersion: 1, draft: draft() }));
    expect(created).toMatchObject({ ok: true, value: { projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/authoritative", revision: 1 } });
    const definition = record(record(created)["value"]);
    const automationId = stringValue(definition["id"]);
    const revision = numberValue(definition["revision"]);

    const run = await backend.request(context(AUTOMATIONS_OPERATIONS.runNow, { contractVersion: 1, automationId, expectedRevision: revision }));
    expect(run).toMatchObject({ ok: true, value: { automationRevision: 1 } });
    expect(runner.createInputs).toEqual([{ projectId: "project-1", workspaceId: "workspace-1", model: { mode: "fixed", provider: "test", id: "model", name: "Test" }, thinking: { mode: "fixed", level: "medium" } }]);
    store.close();
  });

  it("surfaces unexpected store failures instead of mislabeling them as conflicts", () => {
    const store = new AutomationStore(":memory:");
    vi.spyOn(store, "insertDefinition").mockImplementation(() => { throw new Error("disk I/O failed"); });
    const service = new AutomationService(store, new PendingRunner());
    const backend = new AutomationBackend(() => service);

    expect(() => backend.request(context(AUTOMATIONS_OPERATIONS.create, { contractVersion: 1, draft: draft() }))).toThrow("disk I/O failed");
    store.close();
  });

  it("returns stale revision conflicts in-envelope", async () => {
    const store = new AutomationStore(":memory:");
    const service = new AutomationService(store, new PendingRunner());
    const backend = new AutomationBackend(() => service);
    const created = await backend.request(context(AUTOMATIONS_OPERATIONS.create, { contractVersion: 1, draft: draft() }));
    const automationId = stringValue(record(record(created)["value"])["id"]);
    await expect(backend.request(context(AUTOMATIONS_OPERATIONS.delete, { contractVersion: 1, automationId, expectedRevision: 99 }))).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    store.close();
  });
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}
function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
function numberValue(value: unknown): number {
  if (typeof value !== "number") throw new Error("Expected number");
  return value;
}
