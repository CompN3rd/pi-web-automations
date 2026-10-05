import type { AutomationRun } from "./contracts.js";

export function automationColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return `hsl(${String((hash >>> 0) % 360)} 65% 55%)`;
}

export function costSummary(runs: readonly AutomationRun[]) {
  const costs = runs.flatMap((run) => run.usage?.estimatedCostMicros === undefined ? [] : [run.usage.estimatedCostMicros]);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  return { count: runs.length, priced: costs.length, total: costs.length === 0 ? undefined : total, average: costs.length === 0 ? undefined : total / costs.length };
}

export function formatCost(micros: number | undefined): string {
  return micros === undefined ? "—" : `$${(micros / 1_000_000).toFixed(4)}`;
}

export function sessionHref(machineId: string, projectId: string, workspaceId: string, sessionId: string): string {
  const query = new URLSearchParams({ machine: machineId, project: projectId, workspace: workspaceId, session: sessionId });
  return `?${query.toString()}`;
}

export const TIMELINE_HEIGHT = 480;
const MIN_BLOCK_PERCENT = 100 * 6 / TIMELINE_HEIGHT;

export function runTimeline(runs: readonly AutomationRun[], now = Date.now()) {
  const entries = runs.flatMap((run) => {
    const start = Date.parse(run.startedAt ?? run.queuedAt);
    const active = ["queued", "starting", "running", "cancelling"].includes(run.status);
    const end = run.completedAt === undefined ? (active ? now : start) : Date.parse(run.completedAt);
    return Number.isFinite(start) && Number.isFinite(end) ? [{ run, start, end: Math.max(start, end) }] : [];
  });
  const start = entries.length === 0 ? now : Math.min(...entries.map((entry) => entry.start));
  const end = Math.max(start + 1000, ...entries.map((entry) => entry.end));
  const blocks = entries.map((entry) => {
    // Keep even instantaneous runs focusable and inside the chart's bounds.
    const top = Math.min(100 - MIN_BLOCK_PERCENT, 100 * (entry.start - start) / (end - start));
    const height = Math.min(100 - top, Math.max(MIN_BLOCK_PERCENT, 100 * (entry.end - entry.start) / (end - start)));
    return { ...entry, top, height, track: 0 };
  });
  const grouped = new Map<string, typeof blocks>();
  for (const block of blocks) {
    const group = grouped.get(block.run.automationId) ?? [];
    group.push(block);
    grouped.set(block.run.automationId, group);
  }
  const lanes = [...grouped.entries()].map(([automationId, group]) => {
    const trackEnds: number[] = [];
    // Only overlaps within one automation need side-by-side subtracks. Include
    // minimum-size markers in packing so short runs cannot obscure each other.
    group.sort((a, b) => a.start - b.start || a.run.id.localeCompare(b.run.id));
    for (const block of group) {
      const available = trackEnds.findIndex((trackEnd) => trackEnd <= block.top);
      block.track = available === -1 ? trackEnds.length : available;
      trackEnds[block.track] = block.top + block.height;
    }
    return { automationId, name: group[group.length - 1]?.run.automationName ?? automationId, blocks: group, trackCount: trackEnds.length };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.automationId.localeCompare(b.automationId));
  const ticks = Array.from({ length: 5 }, (_, index) => ({ top: index * 25, time: start + (end - start) * index / 4 }));
  return { start, end, blocks, lanes, ticks };
}
