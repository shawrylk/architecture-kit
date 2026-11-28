import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test(".gitattributes keeps LF line endings in every checkout", () => {
  const rules = readFileSync(new URL("../../../../.gitattributes", import.meta.url), "utf8").split("\n").map((line) => line.trim());
  assert.ok(rules.includes("* text=auto eol=lf"), ".gitattributes must hold `* text=auto eol=lf`");
});
