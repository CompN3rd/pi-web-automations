export const SESSION_ARCHIVE_BATCH_LIMIT = 50;

export interface SessionArchiveResult {
  sessionId: string;
  status: "archived" | "already-archived" | "skipped-pinned" | "skipped-busy" | "failed" | "uncertain" | "deferred";
  detail?: string;
}
export interface SessionArchiveSummary {
  results: SessionArchiveResult[];
  traversalComplete: boolean;
  continuationAfter?: string;
  stopReason?: "budget" | "timeout" | "cancelled" | "blocked";
}

export function parseSessionArchiveSummary(value: unknown): SessionArchiveSummary {
  if (typeof value !== "object" || value === null || !("results" in value) || !Array.isArray(value.results)
    || value.results.length > SESSION_ARCHIVE_BATCH_LIMIT || !("traversalComplete" in value) || typeof value.traversalComplete !== "boolean") throw new Error("Invalid session archive response; inspect before retrying");
  const results = value.results.map((entry: unknown): SessionArchiveResult => {
    if (typeof entry !== "object" || entry === null || !("sessionId" in entry) || typeof entry.sessionId !== "string"
      || !("status" in entry) || typeof entry.status !== "string"
      || !isArchiveStatus(entry.status)
      || ("detail" in entry && typeof entry.detail !== "string")) throw new Error("Invalid session archive result");
    return { sessionId: entry.sessionId, status: entry.status, ...("detail" in entry && typeof entry.detail === "string" ? { detail: entry.detail } : {}) };
  });
  const after = "continuationAfter" in value ? value.continuationAfter : undefined;
  if ((!value.traversalComplete && typeof after !== "string") || (after !== undefined && typeof after !== "string")) throw new Error("Invalid session archive continuation");
  const stopReason = "stopReason" in value ? value.stopReason : undefined;
  if (stopReason !== undefined && stopReason !== "budget" && stopReason !== "timeout" && stopReason !== "cancelled" && stopReason !== "blocked") throw new Error("Invalid session archive stop reason");
  return { results, traversalComplete: value.traversalComplete, ...(typeof after === "string" ? { continuationAfter: after } : {}), ...(stopReason ? { stopReason } : {}) };
}

function isArchiveStatus(value: string): value is SessionArchiveResult["status"] {
  return ["archived", "already-archived", "skipped-pinned", "skipped-busy", "failed", "uncertain", "deferred"].includes(value);
}
