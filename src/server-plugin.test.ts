import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerPluginActivationContext } from "@jmfederico/pi-web/server-plugin-api";
import plugin from "./server-plugin.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Automations server plugin", () => {
  it("opens state only under the host directory, starts scheduling at ready, and stops idempotently", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "pi-web-automations-plugin-"));
    roots.push(stateDirectory);
    const context: ServerPluginActivationContext = {
      apiVersion: 1,
      pluginId: "automations",
      packageRoot: stateDirectory,
      stateDirectory,
      settings: {},
      signal: new AbortController().signal,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      execFile: () => Promise.reject(new Error("not used")),
    };
    const activation = await plugin.activate(context);
    expect(activation.workspaceBackend).toBeDefined();
    await activation.start?.(new AbortController().signal);
    expect(existsSync(join(stateDirectory, "automations.sqlite"))).toBe(true);
    expect(existsSync(join(stateDirectory, "automations.sqlite.owner"))).toBe(false);
    expect(await activation.health?.(new AbortController().signal)).toMatchObject({ status: "degraded" });

    await activation.ready?.({ backgroundSessions: { listModels: () => [], create: () => Promise.reject(new Error("not used")) } }, new AbortController().signal);
    expect(await activation.health?.(new AbortController().signal)).toEqual({ status: "healthy" });
    await activation.quiesce?.(new AbortController().signal);
    await activation.stop?.(new AbortController().signal);
    await activation.stop?.(new AbortController().signal);
  });
});
