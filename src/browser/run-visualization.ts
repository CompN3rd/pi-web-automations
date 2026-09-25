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

export function runTimeline(runs: readonly AutomationRun[], now = Date.now()) {
  const entries = runs.flatMap((run) => {
    const start = Date.parse(run.startedAt ?? run.queuedAt);
    const active = ["queued", "starting", "running", "cancelling"].includes(run.status);
    const end = run.completedAt === undefined ? (active ? now : start) : Date.parse(run.completedAt);
    return Number.isFinite(start) && Number.isFinite(end) ? [{ run, start, end: Math.max(start, end) }] : [];
  });
  const start = entries.length === 0 ? now : Math.min(...entries.map((entry) => entry.start));
  const end = Math.max(start + 1000, ...entries.map((entry) => entry.end));
  // Each run gets a separate lane so overlapping and very short runs remain accessible.
  return { start, end, blocks: entries.map((entry) => ({ ...entry, left: 100 * (entry.start - start) / (end - start), width: 100 * (entry.end - entry.start) / (end - start) })) };
}
