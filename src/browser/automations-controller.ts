import type { JsonValue, WorkspacePanelContextV5 } from "@jmfederico/pi-web/plugin-api";
import {
  AUTOMATIONS_CONTRACT_VERSION,
  AUTOMATIONS_OPERATIONS,
  parseAutomationEnvelope,
  parseAutomationSnapshot,
  type AutomationDefinition,
  type AutomationDraft,
  type AutomationModelPolicy,
  type AutomationPatch,
  type AutomationRun,
  type AutomationSnapshot,
  type AutomationThinkingPolicy,
  type AutomationTrigger,
} from "./contracts.js";

export const ACTIVE_POLL_INTERVAL_MS = 2_000;
export const IDLE_POLL_INTERVAL_MS = 15_000;
const STATE_LIMIT = 8;
const ACTIVE_STATUSES = new Set(["queued", "starting", "running", "cancelling"]);

type TimerHandle = ReturnType<typeof setTimeout>;
export interface TimerApi {
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface AutomationTarget {
  projectId: string;
  workspaceId: string;
  label: string;
}

export interface AutomationEditor {
  projectId: string;
  workspaceId: string;
  automationId?: string;
  expectedRevision?: number;
  name: string;
  description: string;
  prompt: string;
  trigger: AutomationTrigger;
  model: AutomationModelPolicy;
  thinking: AutomationThinkingPolicy;
  timeoutMs: number;
}

export interface AutomationPanelState {
  context: WorkspacePanelContextV5;
  snapshot?: AutomationSnapshot;
  loading: boolean;
  mutating: boolean;
  error: string | undefined;
  notice: string | undefined;
  editor?: AutomationEditor;
  selectedId?: string;
  showArchived?: boolean;
  detailTab?: "overview" | "runs" | "configuration";
  workspaceActivity?: boolean;
  confirmation?: { definition: AutomationDefinition; action: "archive" | "delete" };
  targets?: AutomationTarget[];
  targetError?: string;
  targetSequence: number;
  retained: boolean;
  requestSequence: number;
  request: Promise<void> | undefined;
}

const browserTimers: TimerApi = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => { globalThis.clearTimeout(handle); },
};

export class AutomationsController {
  private readonly states = new Map<string, AutomationPanelState>();
  private connectedKey: string | undefined;
  private timer: TimerHandle | undefined;
  private visible = true;

  constructor(private readonly timers: TimerApi = browserTimers) {}

  state(context: WorkspacePanelContextV5): AutomationPanelState {
    return this.stateFor(context);
  }

  connect(context: WorkspacePanelContextV5, visible = true): void {
    const key = contextKey(context);
    const changed = this.connectedKey !== key;
    if (changed) {
      this.invalidateConnectedRequest();
      this.clearTimer();
      this.connectedKey = key;
    }
    this.visible = visible;
    const state = this.stateFor(context);
    if (visible && state.request === undefined && (changed || state.snapshot === undefined)) void this.refresh(context);
  }

  disconnect(context: WorkspacePanelContextV5): void {
    if (this.connectedKey !== contextKey(context)) return;
    this.invalidateConnectedRequest();
    this.connectedKey = undefined;
    this.clearTimer();
  }

  visibilityChanged(context: WorkspacePanelContextV5, visible: boolean): void {
    if (this.connectedKey !== contextKey(context)) return;
    this.visible = visible;
    this.clearTimer();
    if (visible) void this.refresh(context);
  }

  invalidate(context: WorkspacePanelContextV5): Promise<void> {
    return this.refresh(context);
  }

  refresh(context: WorkspacePanelContextV5): Promise<void> {
    const state = this.stateFor(context);
    if (state.request !== undefined) return state.request;
    const sequence = state.requestSequence + 1;
    state.requestSequence = sequence;
    state.loading = state.snapshot === undefined;
    this.render(state);
    const request = this.request(context, AUTOMATIONS_OPERATIONS.snapshot, { contractVersion: AUTOMATIONS_CONTRACT_VERSION, limit: 200 }, parseAutomationSnapshot)
      .then((snapshot) => {
        if (!this.accepts(state, context, sequence)) return;
        state.snapshot = snapshot;
        this.reconcileSelection(state);
        state.error = undefined;
      })
      .catch((error: unknown) => {
        if (this.accepts(state, context, sequence)) state.error = errorMessage(error);
      })
      .finally(() => {
        if (state.request === request) state.request = undefined;
        if (!this.accepts(state, context, sequence)) return;
        state.loading = false;
        this.render(state);
        this.schedule(context, state);
      });
    state.request = request;
    return request;
  }

  beginCreate(context: WorkspacePanelContextV5): void {
    const state = this.stateFor(context);
    const snapshot = state.snapshot;
    state.editor = {
      projectId: context.workspace.projectId, workspaceId: context.workspace.id,
      name: "", description: "", prompt: "", trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" },
      timeoutMs: snapshot?.defaultTimeoutMs ?? 3_600_000,
    };
    state.error = undefined;
    this.render(state);
    void this.discoverTargets(context);
  }

  async discoverTargets(context: WorkspacePanelContextV5): Promise<void> {
    const state = this.stateFor(context);
    const sequence = ++state.targetSequence;
    try {
      const targets: AutomationTarget[] = [];
      for (const project of await context.catalog.projects.list()) {
        for (const workspace of await context.catalog.workspaces.list(project.id)) {
          targets.push({ projectId: project.id, workspaceId: workspace.id, label: `${project.name} / ${workspace.label} (${project.id} / ${workspace.id})` });
        }
      }
      if (!state.retained || state.targetSequence !== sequence || this.connectedKey !== contextKey(context)) return;
      state.targets = targets;
      delete state.targetError;
    } catch (error) {
      if (!state.retained || state.targetSequence !== sequence || this.connectedKey !== contextKey(context)) return;
      delete state.targets;
      state.targetError = `Target discovery failed: ${errorMessage(error)}`;
    }
    this.render(state);
  }

  beginEdit(context: WorkspacePanelContextV5, definition: AutomationDefinition): void {
    const state = this.stateFor(context);
    state.editor = {
      projectId: definition.projectId, workspaceId: definition.workspaceId,
      automationId: definition.id,
      expectedRevision: definition.revision,
      name: definition.name,
      description: definition.description ?? "",
      prompt: definition.prompt,
      trigger: definition.trigger,
      model: definition.model,
      thinking: definition.thinking,
      timeoutMs: definition.timeoutMs,
    };
    state.error = undefined;
    this.render(state);
  }

  cancelEdit(context: WorkspacePanelContextV5): void {
    const state = this.stateFor(context);
    delete state.editor;
    this.render(state);
  }

  updateEditor(context: WorkspacePanelContextV5, patch: Partial<AutomationEditor>): void {
    const state = this.stateFor(context);
    if (state.editor === undefined) return;
    state.editor = { ...state.editor, ...patch };
    this.render(state);
  }

  async saveEditor(context: WorkspacePanelContextV5): Promise<void> {
    const state = this.stateFor(context);
    const editor = state.editor;
    if (editor === undefined) return;
    if (editor.automationId === undefined) {
      const draft: AutomationDraft = editorDraft(editor);
      await this.mutate(context, { action: "create", projectId: editor.projectId, workspaceId: editor.workspaceId, draft: json(draft) },
        `Automation draft created in project ${editor.projectId}, workspace ${editor.workspaceId}. Open that workspace to test and enable it.`);
    } else {
      const patch: AutomationPatch = { ...editorDraft(editor), description: editor.description };
      await this.mutate(context, {
        action: "update",
        automationId: editor.automationId,
        expectedRevision: editor.expectedRevision ?? 0,
        patch: json(patch),
      }, "Automation saved; run it successfully before enabling");
    }
    if (state.error === undefined) delete state.editor;
  }

  runNow(context: WorkspacePanelContextV5, definition: AutomationDefinition): Promise<void> {
    return this.mutate(context, {
      action: "run", automationId: definition.id, expectedRevision: definition.revision,
    }, "Automation queued");
  }

  setEnabled(context: WorkspacePanelContextV5, definition: AutomationDefinition, enabled: boolean): Promise<void> {
    return this.mutate(context, {
      action: enabled ? "enable" : "pause", automationId: definition.id, expectedRevision: definition.revision,
    }, enabled ? "Automation enabled" : "Automation paused");
  }

  selectDefinition(context: WorkspacePanelContextV5, id: string): void {
    const state = this.stateFor(context);
    state.selectedId = id;
    state.workspaceActivity = false;
    delete state.confirmation;
    this.render(state);
  }

  showArchived(context: WorkspacePanelContextV5, archived: boolean): void {
    const state = this.stateFor(context);
    state.showArchived = archived;
    state.workspaceActivity = false;
    delete state.selectedId;
    this.reconcileSelection(state);
    delete state.confirmation;
    this.render(state);
  }

  showDetailTab(context: WorkspacePanelContextV5, tab: "overview" | "runs" | "configuration"): void {
    const state = this.stateFor(context);
    state.detailTab = tab;
    this.render(state);
  }

  showWorkspaceActivity(context: WorkspacePanelContextV5): void {
    const state = this.stateFor(context);
    state.workspaceActivity = true;
    delete state.confirmation;
    this.render(state);
  }

  confirmLifecycle(context: WorkspacePanelContextV5, definition?: AutomationDefinition, action: "archive" | "delete" = "delete"): void {
    const state = this.stateFor(context);
    if (definition) state.confirmation = { definition, action };
    else delete state.confirmation;
    this.render(state);
  }

  async applyLifecycle(context: WorkspacePanelContextV5): Promise<void> {
    const state = this.stateFor(context);
    const confirmation = state.confirmation;
    if (!confirmation || state.mutating) return;
    if (confirmation.action === "delete") await this.delete(context, confirmation.definition);
    else await this.setArchived(context, confirmation.definition, true);
    if (state.error === undefined) delete state.confirmation;
    this.render(state);
  }

  setArchived(context: WorkspacePanelContextV5, definition: AutomationDefinition, archived: boolean): Promise<void> {
    return this.mutate(context, {
      action: archived ? "archive" : "restore", automationId: definition.id, expectedRevision: definition.revision,
    }, archived ? "Automation archived; sessions retained" : "Automation restored with schedule paused");
  }

  delete(context: WorkspacePanelContextV5, definition: AutomationDefinition): Promise<void> {
    return this.mutate(context, {
      action: "delete", automationId: definition.id, expectedRevision: definition.revision,
    }, "Automation deleted");
  }

  cancelRun(context: WorkspacePanelContextV5, run: AutomationRun): Promise<void> {
    return this.mutate(context, {
      action: "cancel", automationId: run.automationId, runId: run.id,
    }, "Cancellation requested; inspect for settlement");
  }

  private async mutate(context: WorkspacePanelContextV5, input: JsonValue, notice: string): Promise<void> {
    const state = this.stateFor(context);
    if (state.mutating) return;
    state.mutating = true;
    state.error = undefined;
    state.notice = undefined;
    this.render(state);
    try {
      const peer = context.backend?.forScope({ kind: "workspace", projectId: context.workspace.projectId, workspaceId: context.workspace.id });
      if (peer?.request === undefined) throw new Error("Automations backend is unavailable on this machine");
      parseManagementResult(await peer.request("manage", input));
      if (this.connectedKey !== contextKey(context)) return;
      state.notice = notice;
      this.clearTimer();
      this.detachRequest(state);
      await this.refresh(context);
    } catch (error) {
      if (this.connectedKey === contextKey(context)) state.error = errorMessage(error);
    } finally {
      state.mutating = false;
      if (this.connectedKey === contextKey(context)) this.render(state);
    }
  }

  private async request<T>(context: WorkspacePanelContextV5, operation: string, input: JsonValue, parser: (value: unknown) => T): Promise<T> {
    if (context.peer?.request === undefined) throw new Error("Automations backend is unavailable on this machine");
    const envelope = parseAutomationEnvelope(await context.peer.request(operation, input));
    if (!envelope.ok) throw new AutomationDomainError(envelope.error.code, envelope.error.message);
    return parser(envelope.value);
  }

  private schedule(context: WorkspacePanelContextV5, state: AutomationPanelState): void {
    this.clearTimer();
    if (!this.visible || this.connectedKey !== contextKey(context)) return;
    const delay = hasActiveRuns(state.snapshot) ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (this.visible && this.connectedKey === contextKey(context)) void this.refresh(context);
    }, delay);
  }

  private accepts(state: AutomationPanelState, context: WorkspacePanelContextV5, sequence: number): boolean {
    return state.retained && state.requestSequence === sequence && this.connectedKey === contextKey(context);
  }

  private invalidateConnectedRequest(): void {
    if (this.connectedKey === undefined) return;
    const state = this.states.get(this.connectedKey);
    if (state !== undefined) this.detachRequest(state);
  }

  private detachRequest(state: AutomationPanelState): void {
    state.requestSequence += 1;
    state.targetSequence += 1;
    state.request = undefined;
  }

  private stateFor(context: WorkspacePanelContextV5): AutomationPanelState {
    const key = contextKey(context);
    const existing = this.states.get(key);
    if (existing !== undefined) {
      existing.context = context;
      this.states.delete(key);
      this.states.set(key, existing);
      return existing;
    }
    if (this.states.size >= STATE_LIMIT) {
      const oldest: string | undefined = this.states.keys().next().value;
      if (oldest !== undefined) {
        const state = this.states.get(oldest);
        if (state !== undefined) { state.retained = false; state.requestSequence += 1; }
        this.states.delete(oldest);
      }
    }
    const created: AutomationPanelState = { context, loading: false, mutating: false, error: undefined, notice: undefined, targetSequence: 0, retained: true, requestSequence: 0, request: undefined };
    this.states.set(key, created);
    return created;
  }

  private reconcileSelection(state: AutomationPanelState): void {
    const visible = state.snapshot?.definitions.filter((definition) => (definition.archivedAt !== undefined) === (state.showArchived === true)) ?? [];
    if (visible.some((definition) => definition.id === state.selectedId)) return;
    const first = visible[0];
    if (first === undefined) delete state.selectedId;
    else state.selectedId = first.id;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private render(state: AutomationPanelState): void {
    if (state.retained && this.connectedKey === contextKey(state.context)) state.context.host.requestRender();
  }
}

export class AutomationDomainError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function hasActiveRuns(snapshot: AutomationSnapshot | undefined): boolean {
  return snapshot?.runs.some((run) => ACTIVE_STATUSES.has(run.status)) ?? false;
}

export function availableThinkingLevels(snapshot: AutomationSnapshot | undefined, policy: AutomationModelPolicy): readonly string[] {
  if (snapshot === undefined || policy.mode === "default") return snapshot?.thinkingLevels ?? [];
  return snapshot.models.find((model) => model.provider === policy.provider && model.id === policy.id)?.thinkingLevels ?? snapshot.thinkingLevels;
}

function editorDraft(editor: AutomationEditor): AutomationDraft {
  return {
    name: editor.name,
    ...(editor.description.trim() === "" ? {} : { description: editor.description }),
    prompt: editor.prompt,
    trigger: editor.trigger,
    model: editor.model,
    thinking: editor.thinking,
    timeoutMs: editor.timeoutMs,
  };
}

function contextKey(context: WorkspacePanelContextV5): string {
  return `${context.machine.id}\u0000${context.workspace.projectId}\u0000${context.workspace.id}`;
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Automations input contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) if (child !== undefined) result[key] = json(child);
    return result;
  }
  throw new Error("Automations input is not JSON-compatible");
}

function parseManagementResult(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !("machine" in value) || !("project" in value) || !("workspace" in value)
    || !("message" in value) || typeof value.message !== "string") throw new Error("Invalid Automations management response");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
