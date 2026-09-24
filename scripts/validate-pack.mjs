import { unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const npmCli = process.env["npm_execpath"];
if (npmCli === undefined) throw new Error("npm_execpath is unavailable; run this validator through npm");
const packed = spawnSync(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts"], { encoding: "utf8" });
if (packed.status !== 0) {
  if (packed.stderr !== undefined) process.stderr.write(packed.stderr);
  if (packed.error !== undefined) console.error(packed.error);
  process.exit(packed.status ?? 1);
}

const reports = JSON.parse(packed.stdout);
if (!Array.isArray(reports) || reports.length !== 1) throw new Error("Expected one npm pack report");
const report = reports[0];
if (typeof report !== "object" || report === null || !Array.isArray(report.files) || typeof report.filename !== "string") {
  throw new Error("Unexpected npm pack JSON report");
}

try {
  const paths = report.files.map((entry) => entry.path);
  const required = ["package.json", "README.md", "LICENSE", "dist/browser/pi-web-plugin.js", "dist/server-plugin.js", "dist/companion.js", "docs/migration.md"];
  for (const path of required) {
    if (!paths.includes(path)) throw new Error(`Packed artifact is missing ${path}`);
  }
  const unexpected = paths.filter((path) => path !== "package.json" && path !== "README.md" && path !== "LICENSE" && !path.startsWith("dist/") && !path.startsWith("docs/"));
  if (unexpected.length > 0) throw new Error(`Packed artifact contains files outside the allowlist: ${unexpected.join(", ")}`);
  console.log(`Validated ${paths.length} packed files (${report.filename}); only package.json and the declared dist/docs/README/LICENSE allowlist are present.`);
} finally {
  await unlink(report.filename).catch(() => undefined);
}
