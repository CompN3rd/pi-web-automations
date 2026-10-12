import type { PiWebHostPiSessionConnection, PiWebHostPiSessionEventsV1, PiWebHostWorkspacesV1, ServerPluginPeerRequestContext } from "@jmfederico/pi-web/server-plugin-api";
import { CHAT_REQUEST, CHAT_REPLY, chatRecord, chatString } from "../browser/chat-protocol.js";
import type { AutomationService } from "./automation-service.js";
import { parseDraft, parsePatch } from "./automation-backend.js";

/** Connections are authorized by the host, not by tool-supplied paths or machine ids. */
export class AutomationChat {
  private readonly connections = new Map<string, Promise<PiWebHostPiSessionConnection>>();
  constructor(
    private readonly service: AutomationService,
    private readonly events: PiWebHostPiSessionEventsV1,
    private readonly workspaces: PiWebHostWorkspacesV1,
    private readonly lifetime: AbortSignal,
  ) {}

  async bind(context: ServerPluginPeerRequestContext): Promise<{ connected: true }> {
    const input = chatRecord(context.input);
    if (Object.keys(input).some((key) => !["sessionId", "machineId", "machineName"].includes(key))) throw new Error("Unexpected chat binding field");
    const sessionId = chatString(input["sessionId"]);
    const machine = { id: chatString(input["machineId"]), name: chatString(input["machineName"]) };
    const selection = { projectId: context.project.id, workspaceId: context.workspace.id, sessionId };
    const key = JSON.stringify(selection);
    let connection = this.connections.get(key);
    if (!connection) {
      connection = this.events.connect(selection).then((connected) => {
        if (this.lifetime.aborted || connected.signal.aborted) { connected.close(); throw new Error("Automation chat connection closed"); }
        connected.on(CHAT_REQUEST, async (data) => {
          let requestId: string;
          try { requestId = chatString(chatRecord(data)["requestId"]); } catch { return; }
          try {
            this.lifetime.throwIfAborted(); connected.signal.throwIfAborted();
            const value = await this.query({ projectId: selection.projectId, workspaceId: selection.workspaceId }, machine, data, connected.signal);
            this.lifetime.throwIfAborted(); connected.signal.throwIfAborted();
            connected.emit(CHAT_REPLY, { requestId, value });
          } catch (error) {
            if (!this.lifetime.aborted && !connected.signal.aborted) connected.emit(CHAT_REPLY, { requestId, error: error instanceof Error ? error.message : String(error) });
          }
        });
        connected.signal.addEventListener("abort", () => { this.connections.delete(key); }, { once: true });
        return connected;
      });
      this.connections.set(key, connection);
      void connection.catch(() => { if (this.connections.get(key) === connection) this.connections.delete(key); });
    }
    await connection;
    context.signal.throwIfAborted();
    return { connected: true };
  }

  close(): void {
    for (const connection of this.connections.values()) void connection.then((value) => { value.close(); }, () => undefined);
    this.connections.clear();
  }

  private async query(current: { projectId: string; workspaceId: string }, machine: { id: string; name: string }, data: unknown, signal: AbortSignal) {
    const input = chatRecord(data);
    const action = input["action"];
    const fields = action === "list" ? [] : action === "inspect" ? ["automationId"]
      : action === "create" ? ["projectId", "workspaceId", "draft"]
      : action === "update" ? ["automationId", "expectedRevision", "patch"] : undefined;
    if (!fields) throw new Error("Unsupported automation chat action");
    if (Object.keys(input).some((key) => !["requestId", "action", ...fields].includes(key))) throw new Error("Unexpected automation query field");
    const currentAuthority = await this.workspaces.resolve(current);
    this.lifetime.throwIfAborted(); signal.throwIfAborted();
    if (action === "create") {
      const hasTarget = input["projectId"] !== undefined || input["workspaceId"] !== undefined;
      const scope = hasTarget ? { projectId: chatString(input["projectId"]), workspaceId: chatString(input["workspaceId"]) } : current;
      const authority = hasTarget ? await this.workspaces.resolve(scope) : currentAuthority;
      this.lifetime.throwIfAborted(); signal.throwIfAborted();
      const definition = this.service.create({ ...scope, workspacePath: authority.workspace.path }, parseDraft(input["draft"]));
      return { machine, project: authority.project, workspace: authority.workspace, saved: true, definition,
        message: "Saved disabled draft. Run/test this revision successfully before enabling its schedule." };
    }
    const scopes = this.service.definitionScopes();
    const ordered = [current, ...scopes.filter((scope) => scope.projectId !== current.projectId || scope.workspaceId !== current.workspaceId)];
    const groups = [];
    let unavailableWorkspaces = 0;
    for (const scope of ordered) {
      let authority = currentAuthority;
      if (scope.projectId !== current.projectId || scope.workspaceId !== current.workspaceId) {
        try { authority = await this.workspaces.resolve(scope); }
        catch { unavailableWorkspaces += 1; continue; }
      }
      this.lifetime.throwIfAborted(); signal.throwIfAborted();
      const definitions = this.service.list({ ...scope, workspacePath: authority.workspace.path });
      groups.push({ project: authority.project, workspace: authority.workspace,
        definitions: action === "list" ? definitions.map((definition) => ({ id: definition.id, name: definition.name, description: definition.description, enabled: definition.enabled, revision: definition.revision, testedRevision: definition.testedRevision, trigger: definition.trigger })) : definitions });
    }
    const attribution = { machine, currentWorkspace: currentAuthority.workspace, generatedAt: new Date().toISOString(), unavailableWorkspaces };
    if (action === "list") return { ...attribution, workspaces: groups };
    const automationId = chatString(input["automationId"]);
    for (const group of groups) {
      const definition = group.definitions.find((item) => item.id === automationId);
      if (definition) {
        const scope = { projectId: group.project.id, workspaceId: group.workspace.id, workspacePath: group.workspace.path };
        if (action === "update") {
          const revision = input["expectedRevision"];
          if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new Error("Update requires expectedRevision from list/inspect");
          const patchInput = chatRecord(input["patch"]);
          if (Object.keys(patchInput).length === 0 || Object.hasOwn(patchInput, "enabled")) throw new Error("Provide saved requirements to edit; enabling is not a requirements edit");
          const patch = parsePatch(patchInput);
          if (Object.keys(patch).length === 0) throw new Error("Provide saved requirements to edit");
          // Other workspace lookups may have awaited since this target was inspected.
          const authority = await this.workspaces.resolve({ projectId: scope.projectId, workspaceId: scope.workspaceId });
          this.lifetime.throwIfAborted(); signal.throwIfAborted();
          const saved = this.service.update(automationId, { ...scope, workspacePath: authority.workspace.path, expectedRevision: revision, ...patch });
          return { ...attribution, project: authority.project, workspace: authority.workspace, saved: true, definition: saved,
            message: "Saved requirements and paused schedule. Run/test the new revision successfully before enabling. Unconfirmed work remains blocked." };
        }
        return { ...attribution, project: group.project, workspace: group.workspace, definition,
          runs: this.service.listRuns(scope, { automationId, limit: 20 }) };
      }
    }
    throw new Error("Automation not found in currently accessible workspaces on this machine; list and use an exact id");
  }
}
