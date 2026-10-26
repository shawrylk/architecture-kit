import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { defaults } from "../config.mjs";

function bareImports(source) {
  const found = [];
  const tree = ts.createSourceFile("source.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
      ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(tree) === "require")
        ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteralLike(specifier) && !/^(?:node:|\.{1,2}\/)/.test(specifier.text)) found.push(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

test("runtime import gate rejects packages in each import form", () => {
  for (const source of ['import spawn from "cross-spawn"', 'import "package"', 'export { x } from "package"', 'import("package")', 'require("package")']) {
    assert.equal(bareImports(source).length, 1, source);
  }
  assert.deepEqual(bareImports('import fs from "node:fs"; import "./local.mjs"; // import "ignored"\nconst example = `import "ignored"`;'), []);
});

test("plugin runtime imports only built-ins and relative files", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const violations = [];
  for (const directory of ["packages/qc-harness/src", "hooks"]) {
    for (const entry of readdirSync(root + directory, { recursive: true }).map(String)) {
      // Test modules execute in the development installation, outside the plugin runtime.
      if (!/\.(?:mjs|js)$/.test(entry) || /\.(?:test|browser-test)\.(?:mjs|js)$/.test(entry)) continue;
      if (directory.endsWith("/src") && !entry.endsWith(".mjs")) continue;
      const file = directory + "/" + entry.replaceAll("\\", "/");
      for (const name of bareImports(readFileSync(root + file, "utf8"))) violations.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("qc check runs from a plugin cache with no node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "qc-cache-"));
  try {
    const source = fileURLToPath(new URL("../", import.meta.url));
    cpSync(source, join(root, "src"), { recursive: true, filter: (file) => !/\.(?:test|browser-test)\.mjs$/.test(file) });
    writeFileSync(join(root, "qc.config.json"), JSON.stringify({
      featureRoots: [],
      gates: Object.fromEntries(Object.keys(defaults.gates).map((name) => [name, false])),
      check: { commands: [`"${process.execPath}" -e 'process.exit(0)'`] },
    }));
    const result = spawnSync(process.execPath, [join(root, "src", "cli", "qc.mjs"), "check"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /RUN /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
