import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected package metadata object");
  return Object.fromEntries(Object.entries(value));
}

describe("standalone Automations package metadata", () => {
  it("declares the public package and exact paired build entries", async () => {
    const metadata: unknown = JSON.parse(await readFile("package.json", "utf8"));
    const packageRecord = record(metadata);
    expect(packageRecord["name"]).toBe("@compn3rd/pi-web-automations");
    expect(packageRecord["version"]).toBe("0.1.0");
    expect(packageRecord["private"]).toBeUndefined();
    expect(packageRecord["license"]).toBe("MIT");
    expect(packageRecord["type"]).toBe("module");
    expect(packageRecord["files"]).toEqual(["dist", "README.md", "LICENSE"]);
    expect(record(packageRecord["dependencies"])).toEqual({ "better-sqlite3": "^13.0.3", croner: "^10.0.1" });
    expect(record(packageRecord["devDependencies"])["@jmfederico/pi-web"]).toBe("github:CompN3rd/pi-web#feat/background-service-plugins");
    expect(packageRecord["peerDependencies"]).toBeUndefined();
    expect(record(packageRecord["engines"])["node"]).toBe(">=22.19.0");
    expect(record(packageRecord["piWeb"])["plugins"]).toEqual([{
      id: "automations",
      browserRoot: "dist/browser",
      module: "dist/browser/pi-web-plugin.js",
      serverModule: "dist/server-plugin.js",
      machineSpecific: true,
    }]);
  });
});
