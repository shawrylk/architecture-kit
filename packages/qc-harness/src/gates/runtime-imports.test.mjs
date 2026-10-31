import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("the hook scan rejects an unresolved script variable", () => {
  assert.throws(() => hookJavaScript('node -e "$MISSING_SCRIPT"'), /unresolved.*MISSING_SCRIPT/i);
});

function hookJavaScript(source) {
  const bodies = [...source.matchAll(/\bnode\s+-e\s+'([^']*)'/g)].map((match) => match[1]);
  const variables = new Map([...source.matchAll(/(?:^|\n)([A-Za-z_]\w*)='([^']*)'/g)].map((match) => [match[1], match[2]]));
  for (const match of source.matchAll(/\bnode\s+-e\s+"\$([A-Za-z_]\w*)"/g)) {
    assert.ok(variables.has(match[1]), `Unresolved hook script variable: ${match[1]}`);
    bodies.push(variables.get(match[1]));
  }
  return bodies;
}

function runtimeImports(root) {
  const violations = [];
  let hookScripts = 0;
  for (const directory of ["packages/qc-harness/src", "hooks"]) {
    for (const entry of readdirSync(join(root, directory), { recursive: true }).map(String)) {
      // Test modules execute in the development installation, outside the plugin runtime.
      if (!/\.(?:mjs|cjs|js|sh)$/.test(entry) || /\.(?:test|browser-test)\.(?:mjs|cjs|js)$/.test(entry)) continue;
      if (entry.endsWith(".sh") && directory !== "hooks") continue;
      const file = directory + "/" + entry.replaceAll("\\", "/");
      const source = readFileSync(join(root, file), "utf8");
      const bodies = entry.endsWith(".sh") ? hookJavaScript(source) : [source];
      if (entry.endsWith(".sh")) hookScripts += bodies.length;
      for (const body of bodies) {
        for (const name of bareImports(body)) violations.push(`${file}: ${name}`);
      }
    }
  }
  return { violations, hookScripts };
}


test("plugin runtime imports only built-ins and relative files", () => {
  const { violations, hookScripts } = runtimeImports(fileURLToPath(new URL("../../../../", import.meta.url)));
  assert.deepEqual(violations, []);
  assert.ok(hookScripts > 0, "the real hooks contain JavaScript scripts to scan");
});

for (const [file, source] of [
  ["hooks/probe.cjs", 'const peer = require("forbidden-peer");'],
  ["packages/qc-harness/src/probe.cjs", 'require("forbidden-peer");'],
  ["hooks/probe.sh", `#!/bin/sh
node -e '
const peer = require("forbidden-peer");
'`],
  ["hooks/variable.sh", `#!/bin/sh
SCRIPT='const peer = require("forbidden-peer");'
node -e "$SCRIPT"`],
]) {
  test(`runtime import gate rejects a bare import in ${file}`, () => {
    const root = mkdtempSync(join(tmpdir(), "qc-runtime-imports-"));
    try {
      mkdirSync(join(root, "hooks"), { recursive: true });
      mkdirSync(join(root, "packages/qc-harness/src"), { recursive: true });
      writeFileSync(join(root, file), source);
      assert.deepEqual(runtimeImports(root).violations, [`${file}: forbidden-peer`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

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
