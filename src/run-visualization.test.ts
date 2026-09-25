import { describe, expect, it } from "vitest";
import type { AutomationRun } from "./browser/contracts.js";
import { automationColor, costSummary, formatCost, runTimeline, sessionHref } from "./browser/run-visualization.js";

function run(patch: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run", automationId: "automation", automationRevision: 1, automationName: "Review",
    projectId: "project", workspaceId: "workspace", workspacePath: "/repo", source: "manual",
    scheduledFor: "2026-01-01T00:00:00Z", status: "completed", prompt: "Review", trigger: { type: "manual" },
    configuredModel: { mode: "default" }, configuredThinking: { mode: "default" }, timeoutMs: 60000,
    queuedAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z", ...patch,
  };
}

describe("run visualization", () => {
  it("excludes unknown costs from averages but includes known zero costs", () => {
    const usage = { scope: "root_session", quality: "partial", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, capturedAt: "2026-01-01T00:01:00Z" } as const;
    expect(costSummary([run(), run({ usage }), run({ usage: { ...usage, estimatedCostMicros: 0 } }), run({ usage: { ...usage, estimatedCostMicros: 2000000 } })])).toEqual({ count: 4, priced: 2, total: 2000000, average: 1000000 });
    expect(costSummary([]).total).toBeUndefined();
    expect(formatCost(undefined)).toBe("—");
    expect(formatCost(0)).toBe("$0.0000");
  });

  it("positions durations on a shared axis and extends only active runs to now", () => {
    const now = Date.parse("2026-01-01T00:02:00Z");
    const active = run({ id: "active", status: "running" });
    delete active.completedAt;
    const skipped = run({ id: "skipped", status: "skipped" });
    delete skipped.startedAt;
    delete skipped.completedAt;
    const timeline = runTimeline([run(), active, skipped], now);
    expect(timeline.blocks.map((block) => block.width)).toEqual([50, 100, 0]);
    expect(timeline.blocks.map((block) => block.left)).toEqual([0, 0, 0]);
    expect(runTimeline([], now).blocks).toEqual([]);
    expect(runTimeline([run({ startedAt: "invalid" })], now).blocks).toEqual([]);
  });

  it("uses stable colors and encodes machine-scoped session links without panel state", () => {
    expect(automationColor("one")).toBe(automationColor("one"));
    expect(automationColor("one")).not.toBe(automationColor("two"));
    const url = new URL(sessionHref("remote & machine", "project", "workspace", "session/?"), "https://example.test/subpath/");
    expect(url.pathname).toBe("/subpath/");
    expect(url.searchParams.get("machine")).toBe("remote & machine");
    expect(url.searchParams.get("session")).toBe("session/?");
    expect(url.searchParams.has("tool")).toBe(false);
  });
});
