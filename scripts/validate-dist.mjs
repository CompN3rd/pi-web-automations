import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const requiredEntries = ["dist/browser/pi-web-plugin.js", "dist/server-plugin.js"];
for (const entry of requiredEntries) await readFile(entry);

const moduleReference = String.raw`(?:\b(?:import|export)\s+(?:(?:type\s+)?[^"';]*?\bfrom\s*)?|\bimport\s*\()\s*["']`;
const forbidden = [
  { label: "PI WEB runtime import", pattern: new RegExp(`${moduleReference}@jmfederico/pi-web(?:/[^"']*)?["']`, "u") },
  { label: "private PI WEB source path", pattern: /(?:pi-web\/src|pi-web\/dist|\.\.\/.*pi-web)/u },
];
for (const path of await javascriptFiles("dist")) {
  const source = await readFile(path, "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) throw new Error(`${rule.label} found in ${path}`);
  }
}
console.log(`Validated ${requiredEntries.length} package entries and emitted JavaScript import boundaries.`);

async function javascriptFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await javascriptFiles(path));
    else if (entry.isFile() && path.endsWith(".js")) paths.push(path);
  }
  return paths;
}
