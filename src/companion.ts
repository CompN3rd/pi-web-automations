import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AUTOMATION_REPLY, AUTOMATION_REQUEST, isRecord, isRequest, type CompanionReply } from "./companion-protocol.js";
import type { AutomationUsageSnapshot } from "./browser/contracts.js";

interface Task {
  requestId: string;
  phase: "preparing" | "ready" | "running";
  prompt?: string;
  started: boolean;
  initialUserMessageSeen: boolean;
  cancelling: boolean;
  stopReason?: string;
  error?: string | undefined;
  modelKey?: string;
  thinkingLevel?: string;
  usage: AutomationUsageSnapshot;
}
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Session-local companion, not an exclusive host lease. Pi owns event listener cleanup. */
export default function companion(pi: Pick<ExtensionAPI, "on" | "events" | "setModel" | "getThinkingLevel" | "setThinkingLevel" | "sendUserMessage">): void {
  let context: ExtensionContext | undefined;
  let active: Task | undefined;
  let abandoned: { requestId: string; error: string } | undefined;
  const reply = (task: Task, operation: CompanionReply["operation"], result: Omit<CompanionReply, "requestId" | "operation">) => {
    pi.events.emit(AUTOMATION_REPLY, { requestId: task.requestId, operation, ...result });
  };
  const abandon = (error: string) => {
    if (!active) return;
    const task = active;
    abandoned = { requestId: task.requestId, error };
    active = undefined; // Never let a delayed cancellation abort later user work.
    reply(task, "run", { status: "unknown", error });
    if (task.phase !== "running") reply(task, "prepare", { status: "unknown", error });
  };
  pi.on("session_start", (_event, ctx) => { context = ctx; });
  pi.on("session_shutdown", () => { abandon("Session shut down or reloaded; inspect the conversation"); context = undefined; });
  pi.on("before_agent_start", (event) => {
    if (!active) return;
    if (active.phase === "running" && !active.started && event.prompt === active.prompt) active.started = true;
    else abandon("Another prompt interfered; inspect the conversation before replacing this automation");
  });
  pi.on("message_start", (event) => {
    if (!active || event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("");
    // A queued continuation may repeat the same text and need not fire
    // before_agent_start again. Only the first matching message is ours.
    if (active.initialUserMessageSeen || text !== active.prompt) {
      abandon("Another user message interfered; cancellation is no longer safe");
    } else {
      active.initialUserMessageSeen = true;
    }
  });
  pi.on("model_select", () => { if (active && active.phase !== "preparing") abandon("Model changed after automation preparation; inspect the conversation"); });
  pi.on("thinking_level_select", () => { if (active && active.phase !== "preparing") abandon("Thinking level changed after automation preparation; inspect the conversation"); });
  pi.on("message_end", (event) => {
    if (active?.started !== true || event.message.role !== "assistant") return;
    const message = event.message;
    active.stopReason = message.stopReason;
    // Final provider success may follow an automatic retry; only settlement decides the result.
    active.error = message.errorMessage;
    const usage = message.usage;
    const tokens = active.usage.tokens;
    tokens.input += usage.input; tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead; tokens.cacheWrite += usage.cacheWrite; tokens.total += usage.totalTokens;
    active.usage.estimatedCostMicros = (active.usage.estimatedCostMicros ?? 0) + Math.round(usage.cost.total * 1_000_000);
  });
  pi.on("agent_settled", () => {
    if (active?.phase !== "running") return;
    const task = active;
    active = undefined;
    task.usage.capturedAt = new Date().toISOString();
    const status = task.cancelling ? "cancelled" : task.started && task.stopReason === "stop" ? "completed" : "failed";
    reply(task, "run", { status, usage: task.usage, ...(status === "failed" ? { error: task.error ?? `Agent ended without successful completion (${task.stopReason ?? "not started"})` } : {}) });
  });
  const handleRequest = async (data: unknown): Promise<void> => {
    if (!isRequest(data)) return;
    const { requestId, operation } = data;
    if (operation === "run" && abandoned?.requestId === requestId) {
      pi.events.emit(AUTOMATION_REPLY, { requestId, operation, status: "unknown", error: abandoned.error }); return;
    }
    if (operation === "cancel") {
      if (active?.requestId !== requestId) return;
      if (active.phase !== "running") {
        const task = active; active = undefined;
        reply(task, "cancel", { status: "cancelled" });
      } else if (context && active.started && !context.hasPendingMessages()) {
        active.cancelling = true;
        context.abort(); // Completion is acknowledged only by agent_settled.
      } else abandon("Cannot safely cancel queued or interleaved work; inspect the conversation");
      return;
    }
    if (operation === "prepare") {
      const task: Task = { requestId, phase: "preparing", started: false, initialUserMessageSeen: false, cancelling: false,
        usage: { scope: "assistant_messages", quality: "partial", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, capturedAt: "" } };
      if (!context || active || !context.isIdle() || context.hasPendingMessages()) {
        reply(task, "prepare", { status: "failed", error: "Companion not ready or session busy" }); return;
      }
      active = task;
      try {
        const model = data["model"]; const thinking = data["thinking"];
        if (!isRecord(model) || !isRecord(thinking)) throw new Error("Invalid model/thinking policy");
        if (model["mode"] === "fixed") {
          if (typeof model["provider"] !== "string" || typeof model["id"] !== "string") throw new Error("Invalid fixed model");
          const selected = context.modelRegistry.getAvailable().find((candidate) => candidate.provider === model["provider"] && candidate.id === model["id"]);
          if (!selected || !await pi.setModel(selected)) throw new Error(`Configured model is unavailable or unauthenticated: ${model["provider"]}/${model["id"]}`);
        } else if (model["mode"] !== "default") throw new Error("Invalid model policy");
        if (active !== task) return;
        if (!context.isIdle() || context.hasPendingMessages()) throw new Error("Session became busy while configuring model");
        if (thinking["mode"] === "fixed") {
          const level = levels.find((candidate) => candidate === thinking["level"]);
          if (!level) throw new Error("Invalid thinking level");
          pi.setThinkingLevel(level);
          if (pi.getThinkingLevel() !== level) throw new Error(`Configured thinking level is unavailable: ${level}`);
        } else if (thinking["mode"] !== "default") throw new Error("Invalid thinking policy");
        if (!context.model) throw new Error("No model configured");
        if (model["mode"] === "fixed" && (context.model.provider !== model["provider"] || context.model.id !== model["id"])) throw new Error("Configured model changed during preparation");
        task.modelKey = `${context.model.provider}/${context.model.id}`;
        task.thinkingLevel = pi.getThinkingLevel();
        task.phase = "ready";
        reply(task, "prepare", { status: "ready", model: { provider: context.model.provider, id: context.model.id, name: context.model.name, thinkingLevels: [] }, thinkingLevel: pi.getThinkingLevel() });
      } catch (error) {
        if (active === task) active = undefined;
        reply(task, "prepare", { status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (operation !== "run" || active?.requestId !== requestId || active.phase !== "ready") return;
    const task = active;
    if (!context || !context.isIdle() || context.hasPendingMessages() || typeof data["prompt"] !== "string" || !data["prompt"].trim()) {
      active = undefined; reply(task, "run", { status: "failed", error: "Session busy or invalid prompt" }); return;
    }
    if (`${context.model?.provider ?? ""}/${context.model?.id ?? ""}` !== task.modelKey || pi.getThinkingLevel() !== task.thinkingLevel) {
      abandon("Model or thinking changed after preparation; inspect the conversation"); return;
    }
    task.phase = "running"; task.prompt = data["prompt"];
    try { pi.sendUserMessage(task.prompt); }
    catch (error) { abandon(`Prompt admission uncertain: ${String(error)}`); }
  };
  pi.events.on(AUTOMATION_REQUEST, (data) => {
    void handleRequest(data).catch((error: unknown) => { abandon(`Companion failure: ${String(error)}`); });
  });
}
