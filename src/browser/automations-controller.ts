import type { JsonValue, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import {
  AUTOMATIONS_CONTRACT_VERSION,
  AUTOMATIONS_OPERATIONS,
  parseAutomationDefinition,
  parseAutomationEnvelope,
  parseAutomationRun,
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

export interface AutomationEditor {
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
  context: WorkspacePanelContext;
  snapshot?: AutomationSnapshot;
  loading: boolean;
  mutating: boolean;
  error: string | undefined;
  notice: string | undefined;
  editor?: AutomationEditor;
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

  state(context: WorkspacePanelContext): AutomationPanelState {
    return this.stateFor(context);
  }

  connect(context: WorkspacePanelContext, visible = true): void {
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

  disconnect(context: WorkspacePanelContext): void {
    if (this.connectedKey !== contextKey(context)) return;
    this.invalidateConnectedRequest();
    this.connectedKey = undefined;
    this.clearTimer();
  }

  visibilityChanged(context: WorkspacePanelContext, visible: boolean): void {
    if (this.connectedKey !== contextKey(context)) return;
    this.visible = visible;
    this.clearTimer();
    if (visible) void this.refresh(context);
  }

  invalidate(context: WorkspacePanelContext): Promise<void> {
    return this.refresh(context);
  }

  refresh(context: WorkspacePanelContext): Promise<void> {
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

  beginCreate(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    const snapshot = state.snapshot;
    state.editor = {
      name: "", description: "", prompt: "", trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" },
      timeoutMs: snapshot?.defaultTimeoutMs ?? 3_600_000,
    };
    state.error = undefined;
    this.render(state);
  }

  beginEdit(context: WorkspacePanelContext, definition: AutomationDefinition): void {
    const state = this.stateFor(context);
    state.editor = {
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

  cancelEdit(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    delete state.editor;
    this.render(state);
  }

  updateEditor(context: WorkspacePanelContext, patch: Partial<AutomationEditor>): void {
    const state = this.stateFor(context);
    if (state.editor === undefined) return;
    state.editor = { ...state.editor, ...patch };
    if (patch.model !== undefined && state.editor.thinking.mode === "fixed" && !availableThinkingLevels(state.snapshot, state.editor.model).includes(state.editor.thinking.level)) {
      state.editor.thinking = { mode: "default" };
    }
    this.render(state);
  }

  async saveEditor(context: WorkspacePanelContext): Promise<void> {
    const state = this.stateFor(context);
    const editor = state.editor;
    if (editor === undefined) return;
    if (editor.automationId === undefined) {
      const draft: AutomationDraft = editorDraft(editor);
      await this.mutate(context, AUTOMATIONS_OPERATIONS.create, { contractVersion: AUTOMATIONS_CONTRACT_VERSION, draft: json(draft) }, parseAutomationDefinition, "Automation draft created");
    } else {
      const patch: AutomationPatch = { ...editorDraft(editor), description: editor.description };
      await this.mutate(context, AUTOMATIONS_OPERATIONS.update, {
        contractVersion: AUTOMATIONS_CONTRACT_VERSION,
        automationId: editor.automationId,
        expectedRevision: editor.expectedRevision ?? 0,
        patch: json(patch),
      }, parseAutomationDefinition, "Automation saved; run it successfully before enabling");
    }
    if (state.error === undefined) delete state.editor;
  }

  runNow(context: WorkspacePanelContext, definition: AutomationDefinition): Promise<void> {
    return this.mutate(context, AUTOMATIONS_OPERATIONS.runNow, {
      contractVersion: AUTOMATIONS_CONTRACT_VERSION, automationId: definition.id, expectedRevision: definition.revision,
    }, parseAutomationRun, "Automation queued");
  }

  setEnabled(context: WorkspacePanelContext, definition: AutomationDefinition, enabled: boolean): Promise<void> {
    return this.mutate(context, AUTOMATIONS_OPERATIONS.update, {
      contractVersion: AUTOMATIONS_CONTRACT_VERSION, automationId: definition.id, expectedRevision: definition.revision, patch: { enabled },
    }, parseAutomationDefinition, enabled ? "Automation enabled" : "Automation paused");
  }

  delete(context: WorkspacePanelContext, definition: AutomationDefinition): Promise<void> {
    return this.mutate(context, AUTOMATIONS_OPERATIONS.delete, {
      contractVersion: AUTOMATIONS_CONTRACT_VERSION, automationId: definition.id, expectedRevision: definition.revision,
    }, parseDeleted, "Automation deleted");
  }

  cancelRun(context: WorkspacePanelContext, run: AutomationRun): Promise<void> {
    return this.mutate(context, AUTOMATIONS_OPERATIONS.cancelRun, {
      contractVersion: AUTOMATIONS_CONTRACT_VERSION, runId: run.id,
    }, parseAutomationRun, "Cancellation requested");
  }

  private async mutate(context: WorkspacePanelContext, operation: string, input: JsonValue, parser: (value: unknown) => unknown, notice: string): Promise<void> {
    const state = this.stateFor(context);
    state.mutating = true;
    state.error = undefined;
    state.notice = undefined;
    this.render(state);
    try {
      await this.request(context, operation, input, parser);
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

  private async request<T>(context: WorkspacePanelContext, operation: string, input: JsonValue, parser: (value: unknown) => T): Promise<T> {
    if (context.backend === undefined) throw new Error("Automations backend is unavailable on this machine");
    const envelope = parseAutomationEnvelope(await context.backend.request(operation, input));
    if (!envelope.ok) throw new AutomationDomainError(envelope.error.code, envelope.error.message);
    return parser(envelope.value);
  }

  private schedule(context: WorkspacePanelContext, state: AutomationPanelState): void {
    this.clearTimer();
    if (!this.visible || this.connectedKey !== contextKey(context)) return;
    const delay = hasActiveRuns(state.snapshot) ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (this.visible && this.connectedKey === contextKey(context)) void this.refresh(context);
    }, delay);
  }

  private accepts(state: AutomationPanelState, context: WorkspacePanelContext, sequence: number): boolean {
    return state.retained && state.requestSequence === sequence && this.connectedKey === contextKey(context);
  }

  private invalidateConnectedRequest(): void {
    if (this.connectedKey === undefined) return;
    const state = this.states.get(this.connectedKey);
    if (state !== undefined) this.detachRequest(state);
  }

  private detachRequest(state: AutomationPanelState): void {
    state.requestSequence += 1;
    state.request = undefined;
  }

  private stateFor(context: WorkspacePanelContext): AutomationPanelState {
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
    const created: AutomationPanelState = { context, loading: false, mutating: false, error: undefined, notice: undefined, retained: true, requestSequence: 0, request: undefined };
    this.states.set(key, created);
    return created;
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
  return snapshot.models.find((model) => model.provider === policy.provider && model.id === policy.id)?.thinkingLevels ?? [];
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

function contextKey(context: WorkspacePanelContext): string {
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

function parseDeleted(value: unknown): true {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("deleted" in value) || value.deleted !== true) throw new Error("Invalid Automations delete response");
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
