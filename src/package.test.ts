import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    expect(packageRecord["files"]).toEqual(["dist", "docs", "README.md", "LICENSE"]);
    expect(record(packageRecord["dependencies"])).toEqual({ "better-sqlite3": "^13.0.3", croner: "^10.0.1" });
    expect(record(packageRecord["devDependencies"])["@jmfederico/pi-web"]).toBe("^1.202609.1");
    expect(record(packageRecord["pi"])["extensions"]).toEqual(["dist/companion.js"]);
    expect(record(packageRecord["devDependencies"])["@earendil-works/pi-coding-agent"]).toBe("^0.87.1");
    expect(record(packageRecord["peerDependencies"])).toEqual({
      "@earendil-works/pi-coding-agent": "*",
      "@jmfederico/pi-web": "^1.202609.1",
    });
    expect(record(packageRecord["engines"])["node"]).toBe(">=22.19.0");
    expect(record(packageRecord["piWeb"])["plugins"]).toEqual([{
      id: "automations",
      browserRoot: "dist/browser",
      module: "dist/browser/pi-web-plugin.js",
      serverModule: "dist/server-plugin.js",
      machineSpecific: true,
    }]);
  });

  it.each([
    ["side-effect import", `import "@jmfederico/pi-web/src/private.js";`],
    ["non-capability public import", `import { imaginaryControl } from "@jmfederico/pi-web/server-plugin-api";`],
    ["re-export", `export { privateApi } from "@jmfederico/pi-web/dist/private.js";`],
  ])("rejects emitted PI WEB %s references", async (_label, source) => {
    const result = await validateDistFixture(source);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PI WEB runtime import found in");
  });
  it("allows only the public server runtime capability imports", async () => {
    const result = await validateDistFixture('import { PI_WEB_HOST_PI_SESSIONS_CAPABILITY } from "@jmfederico/pi-web/server-plugin-api";');
    expect(result.status).toBe(0);
  });
  it("rejects runtime Pi extension imports", async () => {
    const result = await validateDistFixture('import { ExtensionAPI } from "@earendil-works/pi-coding-agent";');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Pi imports must remain companion type boundaries");
  });

});

async function validateDistFixture(source: string): Promise<{ status: number | null; stderr: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-automations-dist-"));
  try {
    await mkdir(join(directory, "dist", "browser"), { recursive: true });
    await writeFile(join(directory, "dist", "browser", "pi-web-plugin.js"), "export default {};\n");
    await writeFile(join(directory, "dist", "server-plugin.js"), "export default {};\n");
    await writeFile(join(directory, "dist", "companion.js"), "export default {};\n");
    await writeFile(join(directory, "dist", "forbidden.js"), source);
    const result = spawnSync(process.execPath, [resolve("scripts/validate-dist.mjs")], { cwd: directory, encoding: "utf8" });
    return { status: result.status, stderr: result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
