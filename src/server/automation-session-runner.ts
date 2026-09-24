import { randomUUID } from "node:crypto";
import type { PiWebHostPiSessionConnection, PiWebHostPiSessionsV1, PiWebHostPiSessionEventsV1, PiWebHostWorkspacesV1 } from "@jmfederico/pi-web/server-plugin-api";
import { AUTOMATION_REQUEST, AUTOMATION_REPLY, isRecord, type AutomationPreparation } from "../companion-protocol.js";
import { parseUsage, parseModel, type AutomationModel, type AutomationUsageSnapshot } from "../browser/contracts.js";

export interface CreatedAutomationSession {
  sessionId: string;
  requestId: string;
  connection?: PiWebHostPiSessionConnection;
  actualModel?: AutomationModel;
  actualThinkingLevel?: string;
  cancelled?: boolean;
  running?: boolean;
  completion?: Promise<AutomationUsageSnapshot>;
  usage?: AutomationUsageSnapshot;
}
export class AutomationExecutionUnknownError extends Error {}
/** A companion-confirmed terminal failure, unlike a lost delivery/connection. */
export class AutomationPromptError extends Error {}

export class AutomationSessionRunner {
  constructor(
    private readonly sessions: PiWebHostPiSessionsV1,
    private readonly events: PiWebHostPiSessionEventsV1,
    private readonly workspaces: PiWebHostWorkspacesV1,
    private readonly lifetime: AbortSignal,
  ) {}

  models(): AutomationModel[] { return []; } // No pre-session catalog capability exists.

  async create(input: AutomationPreparation & { projectId: string; workspaceId: string }, onCreated: (session: CreatedAutomationSession) => void): Promise<CreatedAutomationSession> {
    this.lifetime.throwIfAborted();
    const selection = { projectId: input.projectId, workspaceId: input.workspaceId };
    await this.workspaces.resolve(selection);
    this.lifetime.throwIfAborted();
    const { sessionId } = await this.sessions.create(selection);
    const session: CreatedAutomationSession = { sessionId, requestId: randomUUID() };
    onCreated(session); // Persist identity even if connection/handshake subsequently fails.
    this.lifetime.throwIfAborted();
    session.connection = await this.events.connect({ ...selection, sessionId });
    const reply = await this.exchange(session, "prepare", { model: input.model, thinking: input.thinking }, 5_000);
    if (reply["status"] !== "ready") throw new AutomationPromptError(errorText(reply));
    session.actualModel = parseModel(reply["model"]);
    if (typeof reply["thinkingLevel"] !== "string") throw new Error("Invalid companion thinking level");
    session.actualThinkingLevel = reply["thinkingLevel"];
    return session;
  }

  async run(session: CreatedAutomationSession, prompt: string, capturedAt: () => string): Promise<AutomationUsageSnapshot> {
    if (session.cancelled === true) throw new AutomationPromptError("Automation cancelled before prompt");
    session.running = true;
    session.completion = this.exchange(session, "run", { prompt }).then((reply) => {
      if (reply["usage"] !== undefined) session.usage = { ...parseUsage(reply["usage"]), capturedAt: capturedAt() };
      if (reply["status"] !== "completed") throw new AutomationPromptError(errorText(reply));
      if (!session.usage) throw new AutomationExecutionUnknownError("Companion completion omitted usage");
      return session.usage;
    }).finally(() => { session.running = false; });
    return session.completion;
  }

  snapshot(session: CreatedAutomationSession, capturedAt: string): Promise<AutomationUsageSnapshot | undefined> {
    return Promise.resolve(session.usage ? { ...session.usage, capturedAt } : undefined);
  }

  async abort(session: CreatedAutomationSession): Promise<void> {
    session.cancelled = true;
    if (session.running !== true) return; // No prompt was sent, or our task already settled. Never abort later user work.
    if (!session.connection || session.connection.signal.aborted || this.lifetime.aborted) throw new AutomationExecutionUnknownError("Cancellation connection lost");
    session.connection.emit(AUTOMATION_REQUEST, { requestId: session.requestId, operation: "cancel" });
    try { await session.completion; }
    catch (error) { if (!(error instanceof AutomationPromptError)) throw error; }
  }

  release(session: CreatedAutomationSession): Promise<void> {
    session.connection?.close(); // Closing detaches only; it does not stop a user-owned conversation.
    return Promise.resolve();
  }

  private async exchange(session: CreatedAutomationSession, operation: "prepare" | "run", input: object, timeoutMs?: number): Promise<Record<string, unknown>> {
    const connection = session.connection;
    if (!connection) throw new Error("Automation companion connection missing");
    const signal = AbortSignal.any([this.lifetime, connection.signal]);
    let unsubscribe: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const fail = (message: string) => { reject(operation === "run" ? new AutomationExecutionUnknownError(message) : new Error(message)); };
        onAbort = () => { fail("Automation connection interrupted; inspect the conversation. Work may continue."); };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
        if (timeoutMs !== undefined) timer = setTimeout(() => { fail("No Automations companion handshake within 5 seconds. Enable/trust this package's Pi extension and inspect Sessions."); }, timeoutMs);
        unsubscribe = connection.on(AUTOMATION_REPLY, (data) => {
          if (!isRecord(data) || data["requestId"] !== session.requestId || data["operation"] !== operation) return;
          if (data["status"] === "unknown") { reject(new AutomationExecutionUnknownError(errorText(data))); return; }
          if (["ready", "completed", "cancelled", "failed"].includes(String(data["status"]))) resolve(data);
        });
        try { connection.emit(AUTOMATION_REQUEST, { requestId: session.requestId, operation, ...input }); }
        catch (error) { fail(`Automation delivery uncertain: ${String(error)}`); }
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      unsubscribe?.();
    }
  }
}
function errorText(reply: Record<string, unknown>): string {
  return typeof reply["error"] === "string" ? reply["error"].slice(0, 2000) : `Automation ${String(reply["status"])}`;
}
