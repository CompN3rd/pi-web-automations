import { readFile } from "node:fs/promises";
import { build } from "esbuild";

// Managed Pi installs omit host peers. Bundle only the public API helpers and
// plugin code. SQLite comes from Node; only the scheduler is an installed dependency.
// Keep upstream parsers rather than duplicating capability validation locally.
const hostLicense = await readFile(new URL("../LICENSE", import.meta.resolve("@jmfederico/pi-web/server-plugin-api")), "utf8");
for (const [entry, outfile] of [["src/server-plugin.ts", "dist/server-plugin.js"], ["src/companion.ts", "dist/companion.js"], ["src/chat-tool.ts", "dist/chat-tool.js"]]) await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  external: ["node:sqlite", "croner"],
  // Omit source-path comments so the artifact contains no private host paths.
  minifyWhitespace: true,
  banner: { js: `/*! Includes @jmfederico/pi-web public capability helpers.\n${hostLicense}*/` },
});
