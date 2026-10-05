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
    expect(timeline.blocks.map((block) => block.height)).toEqual([50, 100, 1.25]);
    expect(timeline.blocks.map((block) => block.top)).toEqual([0, 0, 0]);
    expect(timeline.lanes).toHaveLength(1);
    expect(timeline.lanes[0]?.trackCount).toBe(3);
    expect(runTimeline([], now).blocks).toEqual([]);
    expect(runTimeline([run({ startedAt: "invalid" })], now).blocks).toEqual([]);
  });

  it("keeps runs across days in one automation column and aligns concurrent jobs", () => {
    const first = run({ id: "first", completedAt: "2026-01-01T12:00:00Z" });
    const second = run({ id: "second", queuedAt: "2026-01-02T00:00:00Z", startedAt: "2026-01-02T00:00:00Z", completedAt: "2026-01-02T12:00:00Z" });
    const concurrent = run({ ...second, id: "concurrent", automationId: "other", automationName: "Other" });
    const timeline = runTimeline([second, concurrent, first]);
    expect(timeline.lanes).toHaveLength(2);
    const review = timeline.lanes.find((lane) => lane.automationId === "automation");
    expect(review?.blocks.map((block) => block.run.id)).toEqual(["first", "second"]);
    expect(review?.trackCount).toBe(1);
    expect(timeline.blocks[0]?.top).toBeCloseTo(100 * 24 / 36);
    expect(timeline.blocks[0]?.top).toBe(timeline.blocks[1]?.top);
    expect(timeline.blocks[0]?.height).toBe(timeline.blocks[1]?.height);
    expect(timeline.ticks.map((tick) => tick.top)).toEqual([0, 25, 50, 75, 100]);
    expect(timeline.ticks[0]?.time).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(timeline.ticks[4]?.time).toBe(Date.parse("2026-01-02T12:00:00Z"));
  });

  it("packs overlapping runs into subtracks and reuses them after completion", () => {
    const timeline = runTimeline([
      run({ id: "first", completedAt: "2026-01-01T00:03:00Z" }),
      run({ id: "overlap", startedAt: "2026-01-01T00:01:00Z", completedAt: "2026-01-01T00:02:00Z" }),
      run({ id: "after", startedAt: "2026-01-01T00:03:00Z", completedAt: "2026-01-01T00:04:00Z" }),
    ]);
    expect(timeline.lanes[0]?.trackCount).toBe(2);
    expect(timeline.blocks.map((block) => block.track)).toEqual([0, 1, 0]);
  });

  it("keeps minimum-size markers accessible, including at the end of the axis", () => {
    const timeline = runTimeline([
      run({ id: "long", completedAt: "2026-01-03T00:00:00Z" }),
      run({ id: "end-1", startedAt: "2026-01-03T00:00:00Z", completedAt: "2026-01-03T00:00:00Z" }),
      run({ id: "end-2", startedAt: "2026-01-03T00:00:00Z", completedAt: "2026-01-03T00:00:00Z" }),
    ]);
    expect(timeline.blocks.slice(1).map((block) => block.height)).toEqual([1.25, 1.25]);
    expect(new Set(timeline.blocks.map((block) => block.track)).size).toBe(3);
    for (const block of timeline.blocks) expect(block.top + block.height).toBeLessThanOrEqual(100);
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
