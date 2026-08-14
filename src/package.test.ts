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
    expect(packageRecord["files"]).toEqual(["dist", "README.md", "LICENSE"]);
    expect(record(packageRecord["dependencies"])).toEqual({ "better-sqlite3": "^13.0.3", croner: "^10.0.1" });
    expect(record(packageRecord["devDependencies"])["@jmfederico/pi-web"]).toBe("git+https://github.com/CompN3rd/pi-web.git#e9cd5148ea4e71f4094ec6a7e5b953500d40b2a7");
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

  it.each([
    ["side-effect import", `import "@jmfederico/pi-web/src/private.js";`],
    ["re-export", `export { privateApi } from "@jmfederico/pi-web/dist/private.js";`],
  ])("rejects emitted PI WEB %s references", async (_label, source) => {
    const result = await validateDistFixture(source);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PI WEB runtime import found in");
  });
});

async function validateDistFixture(source: string): Promise<{ status: number | null; stderr: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-automations-dist-"));
  try {
    await mkdir(join(directory, "dist", "browser"), { recursive: true });
    await writeFile(join(directory, "dist", "browser", "pi-web-plugin.js"), "export default {};\n");
    await writeFile(join(directory, "dist", "server-plugin.js"), "export default {};\n");
    await writeFile(join(directory, "dist", "forbidden.js"), source);
    const result = spawnSync(process.execPath, [resolve("scripts/validate-dist.mjs")], { cwd: directory, encoding: "utf8" });
    return { status: result.status, stderr: result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
