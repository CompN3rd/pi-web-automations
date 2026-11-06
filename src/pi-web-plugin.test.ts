// @vitest-environment happy-dom

import type { JsonValue, WorkspacePanelContextV5 } from "@jmfederico/pi-web/plugin-api";
import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./browser/pi-web-plugin.js";
import { chatRecord } from "./browser/chat-protocol.js";
import { catalogFixture, managementSuccess } from "./browser-test-fixtures.js";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("standalone Automations browser plugin", () => {
  it("renders session links, colored timeline blocks and all-history cost statistics", async () => {
    const activation = plugin.activate({ apiVersion: 5, pluginId: "automations", runtimePluginId: "automations", html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });
    const panel = activation.contributions.workspacePanels?.[0];
    if (!panel) throw new Error("Expected Automations panel");
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue({
      contractVersion: 1, ok: true, value: {
        definitions: [fixedDefinition()], models: [], thinkingLevels: ["off"],
        defaultTimeoutMs: 600000, minTimeoutMs: 60000, maxTimeoutMs: 86400000, generatedAt: "2026-01-01T00:02:00Z",
        costStatistics: [{ automationId: "created", count: 300, priced: 250, totalMicros: 500000000 }],
        runs: [{ id: "run-1", automationId: "created", automationRevision: 1, automationName: "Fixed job",
          projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/repo", source: "manual",
          scheduledFor: "2026-01-01T00:00:00Z", queuedAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z",
          status: "completed", prompt: "Review", trigger: { type: "manual" }, configuredModel: { mode: "default" }, configuredThinking: { mode: "default" }, timeoutMs: 600000, sessionId: "session & 1",
        }],
      },
    });
    const context = panelContext(backend);
    const container = document.createElement("div"); document.body.append(container);
    try {
      render(panel.render(context), container); await settle(); render(panel.render(context), container);
      const latest = container.querySelector<HTMLAnchorElement>(".definition-card a");
      expect(latest?.textContent).toBe("Open latest session");
      expect(new URL(latest?.href ?? "").searchParams.get("session")).toBe("session & 1");
      expect(container.querySelector(".overview-metrics")?.textContent).toContain("All retained history");
      expect(container.querySelector(".overview-metrics")?.textContent).toContain("$500.0000");
      expect(container.querySelector(".overview-metrics")?.textContent).toContain("$2.0000");
      expect(container.querySelector(".overview-metrics")?.textContent).toContain("250 of 300");
      container.querySelector<HTMLButtonElement>(".activity-link")?.click(); render(panel.render(context), container);
      expect(container.querySelector(".timeline-block")?.getAttribute("aria-label")).toContain("Fixed job · completed");
      expect(container.querySelector(".timeline-block")?.getAttribute("style")).toContain("height:100%");
      expect(container.querySelectorAll(".timeline-lane")).toHaveLength(1);
      expect(container.querySelectorAll(".timeline-tick")).toHaveLength(5);
      expect(container.querySelector(".timeline-heading strong")?.textContent).toBe("Fixed job");
      expect(new URL(container.querySelector<HTMLAnchorElement>("a.timeline-block")?.href ?? "").searchParams.get("session")).toBe("session & 1");
      expect(container.querySelector("tbody a")?.textContent).toBe("Open session");
    } finally { render(null, container); }
  });

  it("groups days in automation columns and aligns simultaneous runs vertically", async () => {
    const activation = plugin.activate({ apiVersion: 5, pluginId: "automations", runtimePluginId: "automations", html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });
    const panel = activation.contributions.workspacePanels?.[0];
    if (!panel) throw new Error("Expected Automations panel");
    const base = {
      automationId: "created", automationRevision: 1, automationName: "Fixed job",
      projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/repo", source: "manual",
      scheduledFor: "2026-01-01T00:00:00Z", queuedAt: "2026-01-01T00:00:00Z",
      status: "completed", prompt: "Review", trigger: { type: "manual" }, configuredModel: { mode: "default" }, configuredThinking: { mode: "default" }, timeoutMs: 600000,
    };
    const later = { startedAt: "2026-01-02T00:00:00Z", completedAt: "2026-01-02T01:00:00Z" };
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue({
      contractVersion: 1, ok: true, value: {
        definitions: [], models: [], thinkingLevels: [], defaultTimeoutMs: 600000, minTimeoutMs: 60000, maxTimeoutMs: 86400000, generatedAt: "2026-01-02T01:00:00Z",
        runs: [
          { ...base, id: "later", ...later },
          { ...base, id: "other", automationId: "other", automationName: "Other job", ...later },
          { ...base, id: "first", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T01:00:00Z" },
        ],
      },
    });
    const context = panelContext(backend);
    const container = document.createElement("div"); document.body.append(container);
    try {
      render(panel.render(context), container); await settle(); render(panel.render(context), container);
      container.querySelector<HTMLButtonElement>(".activity-link")?.click(); render(panel.render(context), container);
      const lanes = container.querySelectorAll(".timeline-lane");
      expect(lanes).toHaveLength(2);
      expect(lanes[0]?.getAttribute("aria-label")).toBe("Fixed job");
      expect(lanes[0]?.querySelectorAll(".timeline-block")).toHaveLength(2);
      expect(lanes[1]?.querySelectorAll(".timeline-block")).toHaveLength(1);
      const fixedBlocks = lanes[0]?.querySelectorAll<HTMLElement>(".timeline-block");
      const otherBlock = lanes[1]?.querySelector<HTMLElement>(".timeline-block");
      expect(fixedBlocks?.[0]?.style.top).toBe("0%");
      expect(fixedBlocks?.[1]?.style.top).toBe(otherBlock?.style.top);
      expect(fixedBlocks?.[1]?.style.height).toBe(otherBlock?.style.height);
      expect(fixedBlocks?.[1]?.getAttribute("tabindex")).toBe("0");
      expect(container.querySelector(".timeline-time-heading")?.textContent).toBe("Time ↓");
    } finally { render(null, container); }
  });

  it("groups selection, configuration and archived lifecycle controls in one detail view", async () => {
    const activation = plugin.activate({ apiVersion: 5, pluginId: "automations", runtimePluginId: "automations", html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });
    const panel = activation.contributions.workspacePanels?.[0];
    if (!panel) throw new Error("Expected Automations panel");
    let definitions = [fixedDefinition(), fixedDefinition({ id: "second", name: "Second job", prompt: "Second prompt" }), fixedDefinition({ id: "archived", name: "Old job", revision: 2, archivedAt: "2026-01-02T00:00:00Z" })];
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockImplementation((operation, input) => {
      if (operation === "manage") {
        const action = chatRecord(input)["action"];
        if (action === "archive") definitions = [fixedDefinition({ revision: 2, archivedAt: "2026-01-02T00:00:00Z" }), ...definitions.slice(1)];
        if (action === "restore") definitions = [fixedDefinition({ revision: 3 }), ...definitions.slice(1)];
        return Promise.resolve(managementSuccess);
      }
      return Promise.resolve(successSnapshot(definitions));
    });
    const context = panelContext(backend);
    const container = document.createElement("div"); document.body.append(container);
    const redraw = async () => { await settle(); render(panel.render(context), container); };
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
      if (!button) throw new Error(`Missing ${label}`);
      button.click(); await redraw();
    };
    try {
      await redraw(); await redraw();
      expect(container.querySelectorAll(".automation-list-item")).toHaveLength(2);
      expect(container.querySelectorAll(".definition-card")).toHaveLength(1);
      expect(container.querySelector(".definition-card h3")?.textContent).toBe("Fixed job");
      await click("Configuration");
      expect(container.querySelector(".configuration pre")?.textContent).toBe("Review");
      container.querySelectorAll<HTMLButtonElement>(".automation-list-item")[1]?.click(); await redraw();
      expect(container.querySelector(".configuration pre")?.textContent).toBe("Second prompt");
      container.querySelectorAll<HTMLButtonElement>(".automation-list-item")[0]?.click(); await redraw();
      await click("Archive");
      expect(backend.mock.calls.filter(([operation]) => operation === "manage")).toHaveLength(0);
      expect(container.querySelector(".lifecycle-confirmation")?.textContent).toContain("Sessions are retained");
      await click("Cancel");
      expect(container.querySelector(".lifecycle-confirmation")).toBeNull();
      await click("Archive"); await click("Confirm archive");
      expect(backend).toHaveBeenCalledWith("manage", { action: "archive", automationId: "created", expectedRevision: 1 });
      expect(container.querySelectorAll(".automation-list-item")).toHaveLength(1);
      await click("Archived · 2");
      expect(container.querySelectorAll(".automation-list-item")).toHaveLength(2);
      expect(container.querySelector(".definition-card h3")?.textContent).toBe("Fixed job");
      expect([...container.querySelectorAll(".definition-actions button")].map((button) => button.textContent.trim())).toEqual(["Restore paused", "Delete"]);
      await click("Restore paused");
      expect(backend).toHaveBeenCalledWith("manage", { action: "restore", automationId: "created", expectedRevision: 2 });
      await click("Current · 2");
      await click("Delete");
      expect(container.querySelector(".lifecycle-confirmation")?.textContent).toContain("cannot be undone");
      await click("Confirm delete");
      expect(backend).toHaveBeenCalledWith("manage", { action: "delete", automationId: "created", expectedRevision: 3 });
    } finally { render(null, container); }
  });

  it("keeps the initially displayed automation selected after rename and refresh reordering", async () => {
    const activation = plugin.activate({ apiVersion: 5, pluginId: "automations", runtimePluginId: "automations", html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });
    const panel = activation.contributions.workspacePanels?.[0];
    if (!panel) throw new Error("Expected Automations panel");
    let definitions = [fixedDefinition({ name: "A job" }), fixedDefinition({ id: "second", name: "B job" })];
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockImplementation((operation, input) => {
      if (operation === "manage") {
        if (chatRecord(input)["action"] === "update") definitions = [fixedDefinition({ id: "second", name: "B job" }), fixedDefinition({ name: "Z job", revision: 2 })];
        return Promise.resolve(managementSuccess);
      }
      return Promise.resolve(successSnapshot(definitions));
    });
    const context = panelContext(backend);
    const container = document.createElement("div"); document.body.append(container);
    const redraw = async () => { await settle(); render(panel.render(context), container); };
    try {
      await redraw(); await redraw();
      expect(container.querySelector(".definition-card h3")?.textContent).toBe("A job");
      [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Edit")?.click(); await redraw();
      const name = [...container.querySelectorAll("label")].find((label) => label.textContent.trim().startsWith("Name"))?.querySelector("input");
      if (!name) throw new Error("Missing Name input");
      name.value = "Z job"; name.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelector<HTMLFormElement>("form")?.requestSubmit(); await redraw();
      expect(container.querySelector(".definition-card h3")?.textContent).toBe("Z job");
      expect(container.querySelector('.automation-list-item[aria-current="true"] strong')?.textContent).toBe("Z job");
      definitions = [fixedDefinition({ id: "earlier", name: "A new job" }), ...definitions];
      [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Refresh")?.click(); await redraw();
      expect(container.querySelector(".definition-card h3")?.textContent).toBe("Z job");
      [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Run now / test")?.click(); await redraw();
      expect(backend).toHaveBeenCalledWith("manage", { action: "run", automationId: "created", expectedRevision: 2 });
    } finally { render(null, container); }
  });

  it("preserves a keyboard focus anchor after opening history and cancelling confirmations", async () => {
    const activation = plugin.activate({ apiVersion: 5, pluginId: "automations", runtimePluginId: "automations", html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });
    const panel = activation.contributions.workspacePanels?.[0];
    if (!panel) throw new Error("Expected Automations panel");
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue(successSnapshot([fixedDefinition()]));
    const context = panelContext(backend);
    const container = document.createElement("div"); document.body.append(container);
    const redraw = async () => { await settle(); render(panel.render(context), container); };
    try {
      await redraw(); await redraw();
      const history = [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "View run history");
      if (!history) throw new Error("Missing history button");
      history.focus(); history.click(); await redraw();
      expect(container.contains(history)).toBe(false);
      expect(document.activeElement).toBe(container.querySelector('[data-detail-tab="runs"]'));
      expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
      for (const action of ["archive", "delete"]) {
        const opener = container.querySelector<HTMLButtonElement>(`[data-lifecycle-action="${action}"]`);
        if (!opener) throw new Error("Missing lifecycle button");
        opener.focus(); opener.click(); await redraw();
        const cancel = [...container.querySelectorAll<HTMLButtonElement>(".lifecycle-confirmation button")].find((button) => button.textContent.trim() === "Cancel");
        if (!cancel) throw new Error("Missing confirmation Cancel");
        cancel.focus(); cancel.click(); await redraw();
        expect(container.querySelector(".lifecycle-confirmation")).toBeNull();
        expect(document.activeElement).toBe(opener);
      }
      for (const action of ["archive", "delete"]) {
        backend.mockResolvedValue(successSnapshot([fixedDefinition()]));
        [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Refresh")?.click(); await redraw();
        container.querySelector<HTMLButtonElement>(`[data-lifecycle-action="${action}"]`)?.click(); await redraw();
        backend.mockResolvedValue(successSnapshot([fixedDefinition()], [{
          id: "active", automationId: "created", automationRevision: 1, automationName: "Fixed job",
          projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/repo", source: "manual",
          scheduledFor: "2026-01-01T00:00:00Z", queuedAt: "2026-01-01T00:00:00Z",
          status: "running", prompt: "Review", trigger: { type: "manual" }, configuredModel: { mode: "default" }, configuredThinking: { mode: "default" }, timeoutMs: 600000,
        }]));
        [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Refresh")?.click(); await redraw();
        expect(container.querySelector<HTMLButtonElement>(`[data-lifecycle-action="${action}"]`)?.disabled).toBe(true);
        const cancel = [...container.querySelectorAll<HTMLButtonElement>(".lifecycle-confirmation button")].find((button) => button.textContent.trim() === "Cancel");
        if (!cancel) throw new Error("Missing confirmation Cancel after refresh");
        cancel.focus(); cancel.click(); await redraw();
        expect(container.querySelector(".lifecycle-confirmation")).toBeNull();
        expect(document.activeElement).toBe(container.querySelector('[data-detail-tab="runs"]'));
      }
      expect(backend.mock.calls.filter(([operation]) => operation === "manage")).toHaveLength(0);
    } finally { render(null, container); }
  });

  it("saves manually entered fixed model identifiers without resetting fixed thinking", async () => {
    const activation = plugin.activate({ apiVersion: 5, pluginId: "automations", runtimePluginId: "automations", html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });
    const panel = activation.contributions.workspacePanels?.[0];
    if (!panel) throw new Error("Expected Automations panel");
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockImplementation((operation) => Promise.resolve(operation === "manage" ? managementSuccess : successSnapshot()));
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
      await change("Target workspace", JSON.stringify(["project-empty", "workspace-empty"]));
      await change("Name", "Fixed job"); await change("Prompt", "Review");
      await change("Thinking", "fixed:high"); await change("Model policy", "fixed");
      await change("Provider", "evaluation"); await change("Model id", "fixed");
      const thinking = [...container.querySelectorAll("label")].find((label) => label.textContent.trim().startsWith("Thinking"))?.querySelector("select");
      expect(thinking?.value).toBe("fixed:high");
      container.querySelector<HTMLFormElement>("form")?.requestSubmit();
      await redraw();
      const submitted = backend.mock.calls.find(([operation]) => operation === "manage")?.[1];
      expect(submitted).toMatchObject({
        action: "create", projectId: "project-empty", workspaceId: "workspace-empty",
        draft: { name: "Fixed job", prompt: "Review", model: { mode: "fixed", provider: "evaluation", id: "fixed" }, thinking: { mode: "fixed", level: "high" } },
      });
    } finally { render(null, container); }
  });
  it("marks saved fixed thinking as selected when mounting an existing definition editor", async () => {
    const activation = plugin.activate({ apiVersion: 5, pluginId: "automations", runtimePluginId: "automations", html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });
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
    const contributions = (plugin.activate({ apiVersion: 5, pluginId: "automations", runtimePluginId: "automations", html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal })).contributions;
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
    expect(container.textContent).toContain("No current automations");
    container.querySelector<HTMLButtonElement>(".activity-link")?.click(); render(panel.render(paired), container);
    expect(container.textContent).toContain("Recent runs");
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);

    render(null, container);
  });
});

function panelContext(request: ((operation: string, input: JsonValue) => Promise<JsonValue>) | undefined, requestRender = vi.fn()): WorkspacePanelContextV5 {
  const unused = (): Promise<never> => Promise.reject(new Error("not used"));
  return {
    navigate: vi.fn(() => Promise.resolve()),
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true },
    files: { readFile: unused, listFiles: unused, writeFile: unused, deleteFile: unused, moveFile: unused },
    catalog: catalogFixture(),
    ...(request === undefined ? {} : { peer: { request }, backend: { machineId: "local", forScope: () => ({ request }) } }),
    host: { requestRender },
    prompt: { insertText() { return undefined; }, getText: () => "", getSelection: () => null },
    terminal: { open() { return undefined; }, runCommand: unused },
  };
}

function fixedDefinition(patch: Record<string, JsonValue> = {}): JsonValue {
  return {
    id: "created", projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/repo",
    name: "Fixed job", prompt: "Review", enabled: false, revision: 1,
    model: { mode: "fixed", provider: "evaluation", id: "fixed" }, thinking: { mode: "fixed", level: "high" },
    trigger: { type: "manual" }, timeoutMs: 600_000, abortGraceMs: 15_000,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function successSnapshot(definitions: JsonValue[] = [], runs: JsonValue[] = []): JsonValue {
  return {
    contractVersion: 1,
    ok: true,
    value: {
      definitions, runs, models: [], thinkingLevels: ["off", "low", "medium", "high"],
      defaultTimeoutMs: 600_000, minTimeoutMs: 60_000, maxTimeoutMs: 86_400_000, generatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}
