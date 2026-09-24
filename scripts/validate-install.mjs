import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const npmCli = process.env["npm_execpath"];
if (!npmCli) throw new Error("Run this validator through npm");
const directory = await mkdtemp(join(tmpdir(), "pi-web-automations-install-"));
function npm(...args) {
  // npm run forwards user allow-scripts as a project-scoped config variable;
  // nested installs reject that form. Let the nested npm read normal user config.
  const { npm_config_allow_scripts: _inheritedAllowScripts, ...env } = process.env;
  const result = spawnSync(process.execPath, [npmCli, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env });
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed: ${result.stderr || result.stdout || String(result.error)}`);
  return result.stdout;
}
try {
  const reports = JSON.parse(npm("pack", "--ignore-scripts", "--json", "--pack-destination", directory));
  if (!Array.isArray(reports) || reports.length !== 1 || typeof reports[0]?.filename !== "string") throw new Error("Unexpected npm pack report");
  npm("install", "--prefix", directory, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", join(directory, reports[0].filename));
  const root = resolve(directory, "node_modules/@compn3rd/pi-web-automations");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const plugin = (await import(pathToFileURL(join(root, manifest.piWeb.plugins[0].serverModule)).href)).default;
  const companion = (await import(pathToFileURL(join(root, manifest.pi.extensions[0])).href)).default;
  if (plugin.apiVersion !== 3 || plugin.name !== "Automations" || typeof companion !== "function") throw new Error("Packaged plugin/companion entries failed to load");
  console.log("Validated clean production-only tarball install and server/companion imports.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
