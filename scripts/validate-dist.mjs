import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";

const requiredEntries = ["dist/browser/pi-web-plugin.js", "dist/server-plugin.js", "dist/companion.js"];
for (const entry of requiredEntries) await readFile(entry);
const capabilities = new Set(["PI_WEB_HOST_PI_SESSIONS_CAPABILITY", "PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY", "PI_WEB_HOST_WORKSPACES_CAPABILITY"]);
for (const path of await moduleFiles("dist")) {
  const source = await readFile(path, "utf8");
  const declaration = path.endsWith(".d.ts");
  const browser = relative("dist", path).replaceAll("\\", "/").startsWith("browser/");
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function inspect(node) {
    let reference;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) reference = node.moduleSpecifier.text;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) reference = node.argument.literal.text;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) reference = node.arguments[0].text;
    if (reference?.startsWith("@jmfederico/pi-web")) {
      const publicType = declaration && ["@jmfederico/pi-web/plugin-api", "@jmfederico/pi-web/server-plugin-api"].includes(reference);
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : undefined;
      const publicRuntime = !declaration && !browser && reference === "@jmfederico/pi-web/server-plugin-api"
        && !node.importClause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0
        && bindings.elements.every((binding) => capabilities.has((binding.propertyName ?? binding.name).text));
      if (!publicType && !publicRuntime) throw new Error(`PI WEB runtime import found in ${path}: ${reference}`);
    }
    if (reference?.startsWith("@earendil-works/") && !(declaration && !browser && reference === "@earendil-works/pi-coding-agent")) {
      throw new Error(`Pi imports must remain companion type boundaries: ${path}`);
    }
    ts.forEachChild(node, inspect);
  }
  inspect(tree);
  if (/(?:pi-web\/src|pi-web\/dist|\.\.\/.*pi-web)/u.test(source)) throw new Error(`private PI WEB source path found in ${path}`);
}
console.log(`Validated ${requiredEntries.length} package entries, public runtime capabilities and declaration import boundaries.`);
async function moduleFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await moduleFiles(path));
    else if (entry.isFile() && (path.endsWith(".js") || path.endsWith(".d.ts"))) paths.push(path);
  }
  return paths;
}
