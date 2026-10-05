import { readFile } from "node:fs/promises";
import { build } from "esbuild";

// Managed Pi installs omit host peers. Bundle only the public API helpers and
// plugin code, leaving native SQLite and the scheduler as installed dependencies.
// Keep upstream parsers rather than duplicating capability validation locally.
const hostLicense = await readFile(new URL("../LICENSE", import.meta.resolve("@jmfederico/pi-web/server-plugin-api")), "utf8");
await build({
  entryPoints: ["src/server-plugin.ts"],
  outfile: "dist/server-plugin.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  external: ["better-sqlite3", "croner"],
  // Omit source-path comments so the artifact contains no private host paths.
  minifyWhitespace: true,
  banner: { js: `/*! Includes @jmfederico/pi-web public capability helpers.\n${hostLicense}*/` },
});
