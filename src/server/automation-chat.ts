import { hostname } from "node:os";
import type { PiWebHostWorkspacesV1, PluginCatalogV1 } from "@jmfederico/pi-web/server-plugin-api";
import { chatRecord, chatString, validateAutomationAction } from "../browser/chat-protocol.js";
import type { AutomationService } from "./automation-service.js";
import { parseDraft, parsePatch } from "./automation-backend.js";

/** Shared machine-local management, with fresh host authority before every mutation. */
export class AutomationChat {
  constructor(
    private readonly service: AutomationService,
    private readonly workspaces: PiWebHostWorkspacesV1,
    private readonly catalog: PluginCatalogV1,
    private readonly lifetime: AbortSignal,
  ) {}

  async query(current: WorkspaceSelection | undefined, data: unknown, signal: AbortSignal, currentWorkspacePath?: unknown) {
    const input = validateAutomationAction(data);
    return withManagementReads(String(input["action"]), signal, this.lifetime,
      (reads) => this.queryInput(current, input, reads, currentWorkspacePath));
  }

  private async discoverTargets(reads: ManagementReads) {
    const targets = [];
    const projects = await reads.read("catalog.projects.list", () => this.catalog.projects.list({ signal: reads.signal }));
    for (const project of projects) {
      const workspaces = await reads.read(`catalog.workspaces.list (project ${project.id})`, () => this.catalog.workspaces.list(project.id, { signal: reads.signal }));
      for (const workspace of workspaces) targets.push({ projectId: project.id, workspaceId: workspace.id, path: workspace.path });
    }
    return targets;
  }

  private async queryInput(current: WorkspaceSelection | undefined, input: Record<string, unknown>, reads: ManagementReads, hint: unknown) {
    const signal = reads.signal;
    signal.throwIfAborted();
    const machine = { id: "local", name: hostname(), scope: "backend machine" };
    const action = input["action"];
    const resolve = (scope: WorkspaceSelection) => reads.read(`workspaces.resolve (project ${scope.projectId}, workspace ${scope.workspaceId})`, () => this.workspaces.resolve(scope));
    if (action === "create") {
      const hasTarget = input["projectId"] !== undefined || input["workspaceId"] !== undefined;
      if (!hasTarget && !current && typeof hint === "string") current = currentWorkspace(await this.discoverTargets(reads), hint);
      const scope = hasTarget ? { projectId: chatString(input["projectId"]), workspaceId: chatString(input["workspaceId"]) } : current;
      if (!scope) throw new Error("Current workspace is ambiguous or unavailable; discover targets and supply BOTH exact projectId/workspaceId");
      const authority = await resolve(scope);
      this.lifetime.throwIfAborted(); signal.throwIfAborted();
      const definition = this.service.create({ ...scope, workspacePath: authority.workspace.path }, parseDraft(input["draft"]));
      return { machine, project: authority.project, workspace: authority.workspace, saved: true, definition,
        message: "Saved disabled draft. Run/test this revision successfully before enabling its schedule." };
    }
    if (action === "list") {
      const requested = input["projectId"] !== undefined
        ? { projectId: chatString(input["projectId"]), workspaceId: chatString(input["workspaceId"]) } : undefined;
      // Exact-scope discovery must not enumerate unrelated providers, even to infer cwd.
      // Machine-wide discovery keeps one catalog snapshot for ordering and listing.
      const targets = requested ? [] : await this.discoverTargets(reads);
      const selected = current ?? currentWorkspace(targets, hint);
      const scopes = requested ? [requested] : targets.map(({ projectId, workspaceId }) => ({ projectId, workspaceId }));
      const ordered = !requested && selected ? [selected, ...scopes.filter((scope) => scope.projectId !== selected.projectId || scope.workspaceId !== selected.workspaceId)] : scopes;
      const groups = [];
      let currentAuthority;
      let unavailableWorkspaces = 0;
      for (const scope of ordered) {
        let authority;
        try { authority = await resolve(scope); }
        catch (error) {
          signal.throwIfAborted();
          if (requested) throw error;
          unavailableWorkspaces += 1; continue;
        }
        if (scope.projectId === selected?.projectId && scope.workspaceId === selected.workspaceId) currentAuthority = authority;
        signal.throwIfAborted();
        const definitions = this.service.list({ ...scope, workspacePath: authority.workspace.path });
        groups.push({ project: authority.project, workspace: authority.workspace,
          definitions: definitions.map((definition) => ({ id: definition.id, name: definition.name, description: definition.description, enabled: definition.enabled, archivedAt: definition.archivedAt, revision: definition.revision, testedRevision: definition.testedRevision, trigger: definition.trigger })) });
      }
      return { machine, currentWorkspace: currentAuthority?.workspace, generatedAt: new Date().toISOString(), unavailableWorkspaces, workspaces: groups };
    }
    const automationId = chatString(input["automationId"]);
    const storedScope = this.service.definitionScope(automationId);
    const notFound = "Automation not found in currently accessible workspaces on this machine; list and use an exact id";
    if (!storedScope) throw new Error(notFound);
    let authority;
    try { authority = await resolve(storedScope); }
    catch { signal.throwIfAborted(); throw new Error(notFound); }
    this.lifetime.throwIfAborted(); signal.throwIfAborted();
    const scope = { ...storedScope, workspacePath: authority.workspace.path };
    const definition = this.service.inspect(automationId, scope);
    const attribution = { machine, generatedAt: new Date().toISOString() };
    if (action === "update") {
      const revision = input["expectedRevision"];
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new Error("Update requires expectedRevision from list/inspect");
      const patchInput = chatRecord(input["patch"]);
      if (Object.keys(patchInput).length === 0 || Object.hasOwn(patchInput, "enabled")) throw new Error("Provide saved requirements to edit; enabling is not a requirements edit");
      const patch = parsePatch(patchInput);
      if (Object.keys(patch).length === 0) throw new Error("Provide saved requirements to edit");
      const saved = this.service.update(automationId, { ...scope, workspacePath: authority.workspace.path, expectedRevision: revision, ...patch });
      return { ...attribution, project: authority.project, workspace: authority.workspace, saved: true, definition: saved,
        message: "Saved requirements and paused schedule. Run/test the new revision successfully before enabling. Unconfirmed work remains blocked." };
    }
    if (action !== "inspect") {
      const revision = input["expectedRevision"];
      if (action !== "cancel" && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)) throw new Error("Action requires expectedRevision from list/inspect");
      const target = { ...scope, workspacePath: authority.workspace.path };
      const result = { ...attribution, project: authority.project, workspace: authority.workspace, automationId };
      const perform = <T>(operation: () => T): T => {
        try { return operation(); }
        catch (error) { throw new Error(`Automation ${automationId}, project ${scope.projectId}, workspace ${scope.workspaceId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      };
      if (action === "cancel") {
        const run = perform(() => this.service.cancel(chatString(input["runId"]), target, automationId));
        return { ...result, run, message: "Cancellation requested (or run already terminal). This is not a force-stop guarantee or proof of settlement. Inspect this run and its session; unknown work remains blocked." };
      }
      // Validated above, kept explicit for the service's typed revision contract.
      if (typeof revision !== "number") throw new Error("Action requires expectedRevision");
      if (action === "run") {
        const run = perform(() => this.service.runNow(automationId, target, revision));
        return { ...result, run, message: "Run/test queued, not completed. Inspect for status and the visible sessionId once created. Only successful settlement tests this revision." };
      }
      if (action === "archive" || action === "restore") {
        const saved = perform(() => this.service.setArchived(automationId, target, revision, action === "archive"));
        return { ...result, definition: saved, message: action === "archive" ? "Automation archived and schedule paused. Sessions and run history retained." : "Automation restored with schedule paused. Sessions unchanged." };
      }
      if (action === "delete") {
        perform(() => { this.service.delete(automationId, target, revision); });
        return { ...result, deleted: true, message: "Definition deleted; run history and session identities retained. Session deletion is not supported by the host plugin API. Deletion does not stop or confirm uncertain session work." };
      }
      const saved = perform(() => this.service.update(automationId, { ...target, expectedRevision: revision, enabled: action === "enable" }));
      return { ...result, definition: saved, message: action === "enable" ? "Schedule enabled for the successfully tested revision." : "Schedule paused; this does not cancel existing runs." };
    }
    return { ...attribution, project: authority.project, workspace: authority.workspace, definition,
      runs: this.service.listRuns(scope, { automationId, limit: 20 }) };
  }
}

interface WorkspaceSelection { projectId: string; workspaceId: string }
interface ManagementReads {
  signal: AbortSignal;
  read<T>(operation: string, work: () => Promise<T>): Promise<T>;
}

function currentWorkspace(targets: (WorkspaceSelection & { path: string })[], hint: unknown): WorkspaceSelection | undefined {
  if (typeof hint !== "string") return undefined;
  const matches = targets.filter((target) => target.path === hint);
  const match = matches.length === 1 ? matches[0] : undefined;
  return match ? { projectId: match.projectId, workspaceId: match.workspaceId } : undefined;
}

/** Leave time to return a useful dependency error before PI WEB's 10s callback deadline. */
async function withManagementReads<T>(action: string, caller: AbortSignal, lifetime: AbortSignal, work: (reads: ManagementReads) => Promise<T>): Promise<T> {
  const timeout = new AbortController();
  const signal = AbortSignal.any([caller, lifetime, timeout.signal]);
  signal.throwIfAborted();
  let phase = "management";
  const timer = setTimeout(() => { timeout.abort(new Error(`Automation ${action}: ${phase} exceeded the 8000ms management read budget; check the hosting machine's catalog/workspace provider and PI WEB logs`)); }, 8000);
  let abort = () => { signal.throwIfAborted(); };
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error("Automation management cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work({
      signal,
      async read(operation, read) {
        signal.throwIfAborted();
        phase = operation;
        try {
          const result = await read();
          signal.throwIfAborted();
          return result;
        } catch (error) {
          signal.throwIfAborted();
          throw new Error(`Automation ${action}: ${operation} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      },
    }), cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
