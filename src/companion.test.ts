import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import companion from "./companion.js";
import { AUTOMATION_REPLY, AUTOMATION_REQUEST } from "./companion-protocol.js";

const requestId = "00000000-0000-0000-0000-000000000001";
const model = { provider: "test", id: "model", name: "Test" };
function fixture() {
  const hooks = new Map<string, (...args: never[]) => unknown>();
  let onRequest: ((data: unknown) => void) | undefined;
  const replies: unknown[] = [];
  let thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> = "medium";
  let idle = true;
  let pending = false;
  let available = true;
  let clamp = false;
  const abort = vi.fn();
  const send = vi.fn<ExtensionAPI["sendUserMessage"]>();
  const setModel = vi.fn<ExtensionAPI["setModel"]>(() => Promise.resolve(true));
  const api = {
    on: (event: string, handler: (...args: never[]) => unknown) => { hooks.set(event, handler); return () => { hooks.delete(event); }; },
    events: {
      on: (channel: string, handler: (data: unknown) => void) => { expect(channel).toBe(AUTOMATION_REQUEST); onRequest = handler; return () => undefined; },
      emit: (channel: string, data: unknown) => { expect(channel).toBe(AUTOMATION_REPLY); replies.push(data); },
    },
    sendUserMessage: send, setModel,
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level: ReturnType<ExtensionAPI["getThinkingLevel"]>) => { thinking = clamp ? "off" : level; },
  };
  companion(api);
  // The fake drives Pi's event boundary with only the context fields used by this extension.
  const context = { model, modelRegistry: { getAvailable: () => available ? [model] : [] }, isIdle: () => idle, hasPendingMessages: () => pending, abort };
  const event = async (name: string, data: object = {}) => {
    const hook = hooks.get(name);
    if (hook === undefined) return;
    const result: unknown = Reflect.apply(hook, undefined, [data, context]);
    await Promise.resolve(result);
  };
  const request = async (operation: string, data: object = {}) => {
    const result: unknown = onRequest?.({ requestId, operation, ...data });
    await Promise.resolve(result);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  const prepare = () => request("prepare", { model: { mode: "fixed", provider: "test", id: "model" }, thinking: { mode: "fixed", level: "medium" } });
  const assistant = (stopReason: string) => event("message_end", { message: { role: "assistant", stopReason, usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { total: 0.005 } } } });
  return { event, request, prepare, assistant, replies, abort, send, setModel, setIdle: (value: boolean) => { idle = value; }, setPending: (value: boolean) => { pending = value; }, setAvailable: (value: boolean) => { available = value; }, setClamp: () => { clamp = true; } };
}

describe("Automations Pi companion", () => {
  it("validates policies then completes only at agent_settled, including automatic retry usage", async () => {
    const f = fixture();
    await f.event("session_start"); await f.prepare();
    expect(f.replies).toEqual([expect.objectContaining({ operation: "prepare", status: "ready", thinkingLevel: "medium" })]);
    expect(f.setModel).toHaveBeenCalledWith(model);
    await f.request("run", { prompt: "Review" });
    expect(f.send).toHaveBeenCalledWith("Review");
    await f.event("before_agent_start", { prompt: "Review" });
    await f.assistant("error"); await f.event("agent_end");
    expect(f.replies).toHaveLength(1);
    await f.assistant("stop"); await f.event("agent_settled");
    expect(f.replies.at(-1)).toMatchObject({ status: "completed", operation: "run", usage: { tokens: { total: 12 }, estimatedCostMicros: 10000 } });
    await f.request("cancel");
    expect(f.abort).not.toHaveBeenCalled();
  });
  it.each(["model", "thinking", "authentication"])("rejects unavailable fixed %s without a prompt or fallback", async (policy) => {
    const f = fixture(); await f.event("session_start");
    if (policy === "model") f.setAvailable(false);
    if (policy === "thinking") f.setClamp();
    if (policy === "authentication") f.setModel.mockResolvedValue(false);
    await f.prepare(); await f.request("run", { prompt: "Review" });
    expect(f.replies.at(-1)).toMatchObject({ status: "failed" });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rechecks idle admission after preparation", async () => {
    const f = fixture(); await f.event("session_start"); await f.prepare();
    f.setIdle(false); await f.request("run", { prompt: "Review" });
    expect(f.replies.at(-1)).toMatchObject({ operation: "run", status: "failed" });
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["model_select", "thinking_level_select"])("detects %s after preparation and does not run or abort user work", async (event) => {
    const f = fixture(); await f.event("session_start"); await f.prepare();
    await f.event(event); await f.request("run", { prompt: "Review" }); await f.request("cancel");
    expect(f.replies.at(-1)).toMatchObject({ operation: "run", status: "unknown" });
    expect(f.send).not.toHaveBeenCalled(); expect(f.abort).not.toHaveBeenCalled();
  });
  it("confirms cancellation only at settlement", async () => {
    const f = fixture(); await f.event("session_start"); await f.prepare();
    await f.request("run", { prompt: "Review" }); await f.event("before_agent_start", { prompt: "Review" });
    await f.request("cancel");
    expect(f.abort).toHaveBeenCalledOnce(); expect(f.replies).toHaveLength(1);
    await f.assistant("aborted"); await f.event("agent_settled");
    expect(f.replies.at(-1)).toMatchObject({ operation: "run", status: "cancelled" });
  });
  it.each([false, true])("abandons an identical consumed continuation (cancel=%s) without attributing later work", async (cancel) => {
    const f = fixture(); await f.event("session_start"); await f.prepare();
    await f.request("run", { prompt: "Review" });
    await f.event("before_agent_start", { prompt: "Review" });
    await f.event("message_start", { message: { role: "user", content: "Review" } });
    await f.assistant("stop");
    // Pi has consumed the follow-up, so the pending queue is empty; no new
    // before_agent_start is needed for this continuation of the same loop.
    f.setPending(false);
    await f.event("message_start", { message: { role: "user", content: [{ type: "text", text: "Review" }] } });
    if (cancel) await f.request("cancel");
    await f.assistant("stop"); await f.event("agent_settled");
    expect(f.replies).toEqual([
      expect.objectContaining({ operation: "prepare", status: "ready" }),
      expect.objectContaining({ operation: "run", status: "unknown" }),
    ]);
    expect(f.abort).not.toHaveBeenCalled();
  });
  it.each(["prompt", "queued", "shutdown"])("abandons %s interference and refuses delayed cancellation", async (interference) => {
    const f = fixture(); await f.event("session_start"); await f.prepare();
    await f.request("run", { prompt: "Review" }); await f.event("before_agent_start", { prompt: "Review" });
    if (interference === "prompt") await f.event("message_start", { message: { role: "user", content: "User work" } });
    if (interference === "queued") { f.setPending(true); await f.request("cancel"); }
    if (interference === "shutdown") await f.event("session_shutdown");
    await f.request("cancel"); await f.event("agent_settled");
    expect(f.replies.at(-1)).toMatchObject({ status: "unknown" });
    expect(f.abort).not.toHaveBeenCalled();
  });
});
