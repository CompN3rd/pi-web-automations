// @vitest-environment happy-dom

import type { JsonValue, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./browser/pi-web-plugin.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("standalone Automations browser plugin", () => {
  it("shows its workspace panel only with a paired backend and requests host renders", async () => {
    const contributions = plugin.activate({ apiVersion: 2, pluginId: "automations", runtimePluginId: "automations", html, svg }).contributions;
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
    ...(request === undefined ? {} : { backend: { request } }),
    host: { requestRender },
    prompt: { insertText() { return undefined; }, getText: () => "", getSelection: () => null },
    terminal: { open() { return undefined; }, runCommand: unused },
  };
}

function successSnapshot(): JsonValue {
  return {
    contractVersion: 1,
    ok: true,
    value: {
      definitions: [], runs: [], models: [], thinkingLevels: ["off", "low", "medium", "high"],
      defaultTimeoutMs: 600_000, minTimeoutMs: 60_000, maxTimeoutMs: 86_400_000, generatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}
