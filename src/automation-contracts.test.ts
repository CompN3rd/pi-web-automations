import { describe, expect, it } from "vitest";
import { parseSessionArchiveSummary } from "./browser/session-archive-result.js";
import { parseAutomationEnvelope } from "./browser/contracts.js";

describe("Automations browser contract", () => {
  it("parses versioned success and error envelopes strictly", () => {
    expect(parseAutomationEnvelope({ contractVersion: 1, ok: true, value: { definitions: [] } })).toMatchObject({ ok: true });
    expect(parseAutomationEnvelope({ contractVersion: 1, ok: false, error: { code: "conflict", message: "changed" } })).toMatchObject({ ok: false });
    expect(() => parseAutomationEnvelope({ contractVersion: 2, ok: true, value: null })).toThrow("Invalid Automations backend response");
    expect(() => parseAutomationEnvelope({ contractVersion: 1, ok: false, error: { message: "missing code" } })).toThrow("Invalid Automations error response");
  });
});

describe("session archive result boundary", () => {
  it.each(["archived", "already-archived", "skipped-pinned", "skipped-busy", "failed", "uncertain", "deferred"])("preserves explicit %s outcomes independently of traversal completion", (status) => {
    const value = { results: [{ sessionId: "full-exact-id", status, detail: "host detail" }], traversalComplete: true };
    expect(parseSessionArchiveSummary(value)).toEqual(value);
  });
  it("accepts continuation including a deferred first cursor", () => {
    const value = { results: [{ sessionId: "full-exact-id", status: "deferred" }], traversalComplete: false, continuationAfter: "" };
    expect(parseSessionArchiveSummary(value)).toEqual(value);
  });
  it("accepts bounded multi-session responses and explicit stop reasons", () => {
    const value = { results: [{ sessionId: "A", status: "archived" }, { sessionId: "B", status: "failed" }], traversalComplete: false, continuationAfter: "B", stopReason: "budget" };
    expect(parseSessionArchiveSummary(value)).toEqual(value);
  });
  it.each([
    null, {}, { results: [], traversalComplete: false },
    { results: [{ sessionId: "id", status: "success" }], traversalComplete: true },
    { results: [{ sessionId: "id", status: "failed", detail: 1 }], traversalComplete: true },
    { results: Array.from({ length: 51 }, (_, index) => ({ sessionId: String(index), status: "archived" })), traversalComplete: true },
    { results: [], traversalComplete: false, continuationAfter: "", stopReason: "success" },
  ])("rejects malformed or unbounded batch response %j", (value) => {
    expect(() => parseSessionArchiveSummary(value)).toThrow("Invalid session archive");
  });
});
