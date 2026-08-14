import { describe, expect, it, vi } from "vitest";
import type { BackgroundSessionLease, BackgroundSessionService, BackgroundSessionUsage } from "@jmfederico/pi-web/server-plugin-api";
import { AutomationSessionRunner } from "./server/automation-session-runner.js";

const usage: BackgroundSessionUsage = { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, total: 6 };

function fixture(promptStatus: "completed" | "failed" = "completed") {
  const request = vi.fn();
  const lease: BackgroundSessionLease = {
    sessionId: "session-1",
    prompt: () => Promise.resolve(promptStatus === "completed" ? { status: "completed", usage } : { status: "failed", usage, error: "provider failed" }),
    snapshot: () => Promise.resolve({ sessionId: "session-1", status: "idle", model: { provider: "test", id: "model", name: "Test" }, thinkingLevel: "medium", usage }),
    abort: () => Promise.resolve(),
    forceStop: () => Promise.resolve(),
    release: () => Promise.resolve(),
  };
  const sessions: BackgroundSessionService = {
    listModels: () => [{ provider: "test", id: "model", name: "Test", thinkingLevels: ["medium"] }],
    create: (input) => { request(input); return Promise.resolve(lease); },
  };
  return { runner: new AutomationSessionRunner(sessions), request };
}

describe("AutomationSessionRunner", () => {
  it("passes authoritative ids and fixed model/thinking atomically to lease creation", async () => {
    const { runner, request } = fixture();
    const created = await runner.create({ projectId: "project-1", workspaceId: "workspace-1", model: { mode: "fixed", provider: "test", id: "model" }, thinking: { mode: "fixed", level: "medium" } }, () => undefined);
    expect(request).toHaveBeenCalledWith({ projectId: "project-1", workspaceId: "workspace-1", model: { provider: "test", id: "model" }, thinkingLevel: "medium" });
    await expect(runner.run(created, "prompt", () => "2026-01-01T00:00:00.000Z")).resolves.toMatchObject({ tokens: { total: 6 } });
  });

  it("turns a failed terminal prompt status into a failed run and keeps unknown cost absent", async () => {
    const { runner } = fixture("failed");
    const created = await runner.create({ projectId: "project-1", workspaceId: "workspace-1", model: { mode: "default" }, thinking: { mode: "default" } }, () => undefined);
    await expect(runner.run(created, "prompt", () => "2026-01-01T00:00:00.000Z")).rejects.toThrow("provider failed");
    await expect(runner.snapshot(created, "2026-01-01T00:00:00.000Z")).resolves.not.toHaveProperty("estimatedCostMicros");
  });
});
