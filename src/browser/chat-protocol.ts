export function chatRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid automation chat message");
  return Object.fromEntries(Object.entries(value));
}

/** Shared action boundary; validate before discovery or any host/backend call. */
export function validateAutomationAction(value: unknown): Record<string, unknown> {
  const input = chatRecord(value);
  const action = input["action"];
  if (typeof action !== "string") throw new Error("Automation action must be a string");
  const required = action === "list" ? [] : action === "inspect" ? ["automationId"]
    : action === "create" ? ["draft"]
    : action === "update" ? ["automationId", "expectedRevision", "patch"]
    : ["run", "enable", "pause", "archive", "restore", "delete"].includes(action) ? ["automationId", "expectedRevision"]
    : action === "cancel" ? ["automationId", "runId"] : undefined;
  if (!required) throw new Error("Use list, inspect, create, update, run, enable, pause, archive, restore, delete, or cancel");
  const allowed = ["action", ...required, ...(action === "archive" ? ["archiveSessions", "archiveSessionAfter"] : []), ...(["list", "create"].includes(action) ? ["projectId", "workspaceId"] : [])];
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`Unexpected automation ${action} field: ${unexpected}`);
  if (input["archiveSessions"] !== undefined && typeof input["archiveSessions"] !== "boolean") throw new Error("archiveSessions must be boolean");
  if (input["archiveSessionAfter"] !== undefined) {
    if (input["archiveSessions"] !== true || typeof input["archiveSessionAfter"] !== "string" || input["archiveSessionAfter"].length > 512) throw new Error("archiveSessionAfter requires archiveSessions: true and an exact continuation cursor");
  }
  for (const field of required) {
    if (input[field] === undefined) throw new Error(`Automation ${action} requires ${field}`);
  }
  for (const field of ["automationId", "runId", "projectId", "workspaceId"]) {
    if (input[field] !== undefined) {
      try { chatString(input[field]); }
      catch { throw new Error(`Automation ${action} requires an exact ${field} identity from list/inspect`); }
    }
  }
  if (["list", "create"].includes(action) && (input["projectId"] !== undefined) !== (input["workspaceId"] !== undefined)) {
    throw new Error(`Automation ${action} target identity requires BOTH exact projectId/workspaceId`);
  }
  if (required.includes("expectedRevision")) {
    const revision = input["expectedRevision"];
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new Error(`Automation ${action} requires expectedRevision from list/inspect (positive safe integer)`);
  }
  for (const field of ["draft", "patch"]) {
    if (required.includes(field)) {
      const requirements = input[field];
      if (typeof requirements !== "object" || requirements === null || Array.isArray(requirements) || Object.keys(requirements).length === 0) {
        throw new Error(`Automation ${action} requires nonempty ${field} saved requirements`);
      }
    }
  }
  return input;
}

export function chatString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("Invalid automation chat identity");
  return value;
}
