import { describe, expect, it, vi } from "vitest";
import type { ServerPluginPeerRequestContext } from "@jmfederico/pi-web/server-plugin-api";
import { AutomationBackend, parseDraft, parsePatch } from "./server/automation-backend.js";
import { AutomationService } from "./server/automation-service.js";
import { AutomationStore } from "./server/automation-store.js";

function context(operation: string, input: ServerPluginPeerRequestContext["input"]): ServerPluginPeerRequestContext {
  return {
    project: { id: "project-1", name: "Project", path: "/registered" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/authoritative", label: "main", isMain: true },
    operation, input, signal: new AbortController().signal,
  };
}
const draft = { name: "Review", prompt: "Review", trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" } };

describe("AutomationBackend read-only snapshot", () => {
  function fixture() {
    const store = new AutomationStore(":memory:");
    const unused = () => Promise.reject(new Error("unused"));
    const service = new AutomationService(store, { models: () => [], create: unused, run: unused, snapshot: unused, abort: unused, release: unused });
    return { store, service, backend: new AutomationBackend(() => service) };
  }
  it("reads the host-scoped snapshot and rejects caller scope, version mismatches and invalid limits", async () => {
    const { store, service, backend } = fixture();
    try {
      service.create({ projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/authoritative" }, parseDraft(draft));
      await expect(backend.request(context("snapshot", { contractVersion: 1 }))).resolves.toMatchObject({ ok: true, value: { definitions: [{ workspacePath: "/authoritative" }], runs: [] } });
      await expect(backend.request({ ...context("snapshot", { contractVersion: 1 }), workspace: { ...context("snapshot", {}).workspace, id: "other" } })).resolves.toMatchObject({ value: { definitions: [] } });
      for (const input of [{ contractVersion: 1, projectId: "other" }, { contractVersion: 1, limit: 201 }, { contractVersion: 2 }]) {
        await expect(backend.request(context("snapshot", input))).resolves.toMatchObject({ ok: false });
      }
    } finally { store.close(); }
  });
  it("has no separate mutation implementation; all callers must use shared management", async () => {
    const { store, backend } = fixture();
    try {
      for (const operation of ["create", "update", "delete", "run-now", "cancel-run"]) {
        await expect(backend.request(context(operation, { contractVersion: 1 }))).resolves.toMatchObject({ ok: false, error: { code: "unknown-operation" } });
      }
    } finally { store.close(); }
  });
  it("does not disguise unexpected storage failures as domain errors", () => {
    const { store, service, backend } = fixture();
    try {
      vi.spyOn(service, "list").mockImplementation(() => { throw new Error("disk I/O failed"); });
      expect(() => backend.request(context("snapshot", { contractVersion: 1 }))).toThrow("disk I/O failed");
    } finally { store.close(); }
  });
  it("strictly parses shared draft and patch requirements", () => {
    expect(parseDraft(draft)).toEqual(draft);
    expect(parsePatch({ prompt: "changed", description: "" })).toEqual({ prompt: "changed", description: "" });
    expect(() => parseDraft({ ...draft, cwd: "/evil" })).toThrow("Unexpected input field: cwd");
    expect(() => parsePatch({ expectedRevision: 1 })).toThrow("Unexpected input field");
  });
});
