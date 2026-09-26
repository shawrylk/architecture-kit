import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const template = (name) => readFileSync(new URL(`../../templates/${name}`, import.meta.url), "utf8");

test("the template workflow checks out full history, so the threshold ratchet has a merge base", () => {
  assert.match(template("github/workflows/ci.yml"), /uses: actions\/checkout@v\d+\s*\n\s*with: \{ fetch-depth: 0 \}/);
});
