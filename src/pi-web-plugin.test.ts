// @vitest-environment happy-dom

import type { JsonValue, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./browser/pi-web-plugin.js";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("standalone Automations browser plugin", () => {
  it("saves manually entered fixed model identifiers without resetting fixed thinking", async () => {
    const activation = await plugin.activate({ apiVersion: 4, pluginId: "automations", runtimePluginId: "automations", html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });
    const panel = activation.contributions.workspacePanels?.[0];
    if (!panel) throw new Error("Expected Automations panel");
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockImplementation((operation) => Promise.resolve(operation === "create" ? {
      contractVersion: 1, ok: true, value: fixedDefinition(),
    } : successSnapshot()));
    const context = panelContext(backend);
    const container = document.createElement("div"); document.body.append(container);
    const redraw = async () => { await settle(); render(panel.render(context), container); };
    const change = async (label: string, value: string) => {
      const field = [...container.querySelectorAll("label")].find((item) => item.textContent.trim().startsWith(label))?.querySelector("input,textarea,select");
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) throw new Error(`Missing field: ${label}`);
      field.value = value;
      field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
      await redraw();
    };
    try {
      await redraw(); await redraw();
      [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "New automation")?.click();
      await redraw();
      await change("Name", "Fixed job"); await change("Prompt", "Review");
      await change("Thinking", "fixed:high"); await change("Model policy", "fixed");
      await change("Provider", "evaluation"); await change("Model id", "fixed");
      const thinking = [...container.querySelectorAll("label")].find((label) => label.textContent.trim().startsWith("Thinking"))?.querySelector("select");
      expect(thinking?.value).toBe("fixed:high");
      container.querySelector<HTMLFormElement>("form")?.requestSubmit();
      await redraw();
      const submitted = backend.mock.calls.find(([operation]) => operation === "create")?.[1];
      expect(submitted).toMatchObject({
        contractVersion: 1,
        draft: { name: "Fixed job", prompt: "Review", model: { mode: "fixed", provider: "evaluation", id: "fixed" }, thinking: { mode: "fixed", level: "high" } },
      });
    } finally { render(null, container); }
  });
  it("marks saved fixed thinking as selected when mounting an existing definition editor", async () => {
    const activation = await plugin.activate({ apiVersion: 4, pluginId: "automations", runtimePluginId: "automations", html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });
    const panel = activation.contributions.workspacePanels?.[0];
    if (!panel) throw new Error("Expected Automations panel");
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue(successSnapshot([fixedDefinition()]));
    const context = panelContext(backend);
    const container = document.createElement("div"); document.body.append(container);
    try {
      render(panel.render(context), container); await settle(); render(panel.render(context), container);
      const edit = [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Edit");
      if (!edit) throw new Error("Expected saved definition Edit button");
      edit.click(); render(panel.render(context), container);
      const thinking = [...container.querySelectorAll("label")].find((label) => label.textContent.trim().startsWith("Thinking"))?.querySelector("select");
      // happy-dom mis-selects late-inserted options even for plain HTML with
      // `selected`. Assert native initial-selection markup here; the isolated
      // real-browser smoke also checks the live select.value after reopening.
      const selected = thinking?.querySelectorAll<HTMLOptionElement>("option[selected]");
      expect(selected?.length).toBe(1);
      expect(selected?.[0]?.value).toBe("fixed:high");
    } finally { render(null, container); }
  });
  it("shows its workspace panel only with a paired backend and requests host renders", async () => {
    const contributions = (await plugin.activate({ apiVersion: 4, pluginId: "automations", runtimePluginId: "automations", html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal })).contributions;
    const panel = contributions.workspacePanels?.[0];
    if (panel === undefined) throw new Error("Expected Automations panel");
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue(successSnapshot());
    const requestRender = vi.fn();
    const paired = panelContext(backend, requestRender);
    const unpaired = panelContext(undefined);

    expect(panel.id).toBe("workspace.automations");
    expect(panel.visible?.(paired)).toBe(true);
    expect(panel.visible?.(unpaired)).toBe(false);

    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(paired), container);
    await settle();
    render(panel.render(paired), container);

    expect(backend).toHaveBeenCalledWith("snapshot", { contractVersion: 1, limit: 200 });
    expect(requestRender).toHaveBeenCalled();
    expect(container.textContent).toContain("Automations");
    expect(container.textContent).toContain("No automations yet");
    expect(container.textContent).toContain("Recent runs");
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);

    render(null, container);
  });
});

function panelContext(request: ((operation: string, input: JsonValue) => Promise<JsonValue>) | undefined, requestRender = vi.fn()): WorkspacePanelContext {
  const unused = (): Promise<never> => Promise.reject(new Error("not used"));
  return {
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true },
    files: { readFile: unused, listFiles: unused, writeFile: unused, deleteFile: unused, moveFile: unused },
    ...(request === undefined ? {} : { peer: { request } }),
    host: { requestRender },
    prompt: { insertText() { return undefined; }, getText: () => "", getSelection: () => null },
    terminal: { open() { return undefined; }, runCommand: unused },
  };
}

function fixedDefinition(): JsonValue {
  return {
    id: "created", projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/repo",
    name: "Fixed job", prompt: "Review", enabled: false, revision: 1,
    model: { mode: "fixed", provider: "evaluation", id: "fixed" }, thinking: { mode: "fixed", level: "high" },
    trigger: { type: "manual" }, timeoutMs: 600_000, abortGraceMs: 15_000,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function successSnapshot(definitions: JsonValue[] = []): JsonValue {
  return {
    contractVersion: 1,
    ok: true,
    value: {
      definitions, runs: [], models: [], thinkingLevels: ["off", "low", "medium", "high"],
      defaultTimeoutMs: 600_000, minTimeoutMs: 60_000, maxTimeoutMs: 86_400_000, generatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}
