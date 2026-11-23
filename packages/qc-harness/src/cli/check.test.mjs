import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaults, merge } from "../config.mjs";
import { runCheck } from "./check.mjs";

function proseFixture(t, file) {
  const root = mkdtempSync(path.join(tmpdir(), "qc-prose-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, "docs", file), "// Utilize helpers.\n");
  return (plainLanguage = {}) => ({
    ...merge(defaults, {
      featureRoots: [],
      gates: {
        ...Object.fromEntries(Object.keys(defaults.gates).map((name) => [name, false])),
        "plain-language": true,
      },
      plainLanguage: { roots: ["docs"], ...plainLanguage },
    }),
    root,
  });
}

test("runCheck reads JavaScript comments with the default prose extensions", async (t) => {
  const config = proseFixture(t, "note.js");
  const { problems } = await runCheck(config());
  assert.deepEqual(problems.map(({ path, rule }) => ({ path, rule })), [
    { path: "docs/note.js", rule: "unapproved-word" },
  ]);
});

test("runCheck honors the prose extensions and excludes", async (t) => {
  const config = proseFixture(t, "note.mjs");
  const extensions = await runCheck(config({ extensions: ["js"] }));
  const exclude = await runCheck(config({ exclude: ["note\\.mjs$"] }));
  assert.deepEqual({ extensions: extensions.problems, exclude: exclude.problems }, {
    extensions: [],
    exclude: [],
  });
});
