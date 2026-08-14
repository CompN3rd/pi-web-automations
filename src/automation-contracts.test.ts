import { describe, expect, it } from "vitest";
import { parseAutomationEnvelope } from "./browser/contracts.js";

describe("Automations browser contract", () => {
  it("parses versioned success and error envelopes strictly", () => {
    expect(parseAutomationEnvelope({ contractVersion: 1, ok: true, value: { definitions: [] } })).toMatchObject({ ok: true });
    expect(parseAutomationEnvelope({ contractVersion: 1, ok: false, error: { code: "conflict", message: "changed" } })).toMatchObject({ ok: false });
    expect(() => parseAutomationEnvelope({ contractVersion: 2, ok: true, value: null })).toThrow("Invalid Automations backend response");
    expect(() => parseAutomationEnvelope({ contractVersion: 1, ok: false, error: { message: "missing code" } })).toThrow("Invalid Automations error response");
  });
});
