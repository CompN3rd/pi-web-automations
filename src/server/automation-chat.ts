import { hostname } from "node:os";
import type { PiWebHostWorkspacesV1, PluginCatalogV1 } from "@jmfederico/pi-web/server-plugin-api";
import { chatRecord, chatString } from "../browser/chat-protocol.js";
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

  async currentWorkspace(hint: unknown, signal: AbortSignal): Promise<{ projectId: string; workspaceId: string } | undefined> {
    if (typeof hint !== "string") return undefined;
    const matches = [];
    for (const project of await this.catalog.projects.list({ signal })) {
      for (const workspace of await this.catalog.workspaces.list(project.id, { signal })) {
        if (workspace.path === hint) matches.push({ projectId: project.id, workspaceId: workspace.id });
      }
    }
    this.lifetime.throwIfAborted(); signal.throwIfAborted();
    return matches.length === 1 ? matches[0] : undefined;
  }

  async query(current: { projectId: string; workspaceId: string } | undefined, data: unknown, signal: AbortSignal) {
    this.lifetime.throwIfAborted(); signal.throwIfAborted();
    const machine = { id: "local", name: hostname(), scope: "backend machine" };
    const input = chatRecord(data);
    const action = input["action"];
    const fields = action === "list" ? [] : action === "inspect" ? ["automationId"]
      : action === "create" ? ["projectId", "workspaceId", "draft"]
      : action === "update" ? ["automationId", "expectedRevision", "patch"]
      : ["run", "enable", "pause", "delete"].includes(String(action)) ? ["automationId", "expectedRevision"]
      : action === "cancel" ? ["automationId", "runId"] : undefined;
    if (!fields) throw new Error("Unsupported automation chat action");
    if (Object.keys(input).some((key) => !["action", ...fields].includes(key))) throw new Error("Unexpected automation query field");
    if (action === "create") {
      const hasTarget = input["projectId"] !== undefined || input["workspaceId"] !== undefined;
      const scope = hasTarget ? { projectId: chatString(input["projectId"]), workspaceId: chatString(input["workspaceId"]) } : current;
      if (!scope) throw new Error("Current workspace is ambiguous or unavailable; discover targets and supply BOTH exact projectId/workspaceId");
      const authority = await this.workspaces.resolve(scope);
      this.lifetime.throwIfAborted(); signal.throwIfAborted();
      const definition = this.service.create({ ...scope, workspacePath: authority.workspace.path }, parseDraft(input["draft"]));
      return { machine, project: authority.project, workspace: authority.workspace, saved: true, definition,
        message: "Saved disabled draft. Run/test this revision successfully before enabling its schedule." };
    }
    if (action === "list") {
      const currentAuthority = current ? await this.workspaces.resolve(current) : undefined;
      const projects = await this.catalog.projects.list({ signal });
      const scopes = [];
      for (const project of projects) {
        for (const workspace of await this.catalog.workspaces.list(project.id, { signal })) {
          scopes.push({ projectId: project.id, workspaceId: workspace.id });
        }
      }
      const ordered = current ? [current, ...scopes.filter((scope) => scope.projectId !== current.projectId || scope.workspaceId !== current.workspaceId)] : scopes;
      const groups = [];
      let unavailableWorkspaces = 0;
      for (const scope of ordered) {
        let authority = currentAuthority;
        if (scope.projectId !== current?.projectId || scope.workspaceId !== current.workspaceId) {
          try { authority = await this.workspaces.resolve(scope); }
          catch { unavailableWorkspaces += 1; continue; }
        }
        this.lifetime.throwIfAborted(); signal.throwIfAborted();
        if (!authority) throw new Error("Missing workspace authority");
        const definitions = this.service.list({ ...scope, workspacePath: authority.workspace.path });
        groups.push({ project: authority.project, workspace: authority.workspace,
          definitions: definitions.map((definition) => ({ id: definition.id, name: definition.name, description: definition.description, enabled: definition.enabled, revision: definition.revision, testedRevision: definition.testedRevision, trigger: definition.trigger })) });
      }
      return { machine, currentWorkspace: currentAuthority?.workspace, generatedAt: new Date().toISOString(), unavailableWorkspaces, workspaces: groups };
    }
    const automationId = chatString(input["automationId"]);
    const storedScope = this.service.definitionScope(automationId);
    const notFound = "Automation not found in currently accessible workspaces on this machine; list and use an exact id";
    if (!storedScope) throw new Error(notFound);
    let authority;
    try { authority = await this.workspaces.resolve(storedScope); }
    catch { throw new Error(notFound); }
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
      if (action === "delete") {
        perform(() => { this.service.delete(automationId, target, revision); });
        return { ...result, deleted: true, message: "Definition archived; run history and session identities retained. Deletion does not stop or confirm uncertain session work." };
      }
      const saved = perform(() => this.service.update(automationId, { ...target, expectedRevision: revision, enabled: action === "enable" }));
      return { ...result, definition: saved, message: action === "enable" ? "Schedule enabled for the successfully tested revision." : "Schedule paused; this does not cancel existing runs." };
    }
    return { ...attribution, project: authority.project, workspace: authority.workspace, definition,
      runs: this.service.listRuns(scope, { automationId, limit: 20 }) };
  }
}
