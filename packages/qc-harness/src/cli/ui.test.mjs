import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "../config.mjs";
import { runCheck } from "./check.mjs";
import { runUi } from "./ui.mjs";

const ROOT_UI = "frontend/src/platform/ui";
// A project with no feature folder also trips the unrelated root check.
const uiProblems = async (config) => (await runCheck(config)).problems.filter((problem) => problem.rule !== "unfound-root");

function project(files, config = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-ui-"));
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify(config));
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), contents);
  }
  return root;
}

async function ui(root, ...args) {
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (line) => out.push(String(line));
  console.error = (line) => err.push(String(line));
  try {
    const code = await runUi(load(root), args);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const FILES = {
  [`${ROOT_UI}/button.tsx`]: `/** A pressable control. */\nexport function Button({ label }: { label: string }) { return <button className="text-[11px] rounded-[4px]">{label}</button>; }\n`,
  [`${ROOT_UI}/panel.tsx`]: `export const Panel = () => <div className={cn("text-[11px]")} />;\n`,
};

test("qc ui catalog writes the catalog, --check passes then fails once a component changes", async () => {
  const root = project(FILES);
  try {
    assert.match((await ui(root, "catalog")).out, /wrote docs\/ui-catalog\.md: 2 component/);
    const text = readFileSync(path.join(root, "docs/ui-catalog.md"), "utf8");
    assert.match(text, /`Button`/);
    assert.equal((await ui(root, "catalog", "--check")).code, 0);
    writeFileSync(path.join(root, ROOT_UI, "card.tsx"), "export const Card = () => null;\n");
    const stale = await ui(root, "catalog", "--check");
    assert.equal(stale.code, 1);
    assert.match(stale.err, /stale/);
    assert.equal(JSON.parse((await ui(root, "catalog", "--json")).out).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repository with no component under its roots gets no catalog and no failure", async () => {
  const root = project({ "src/readme.txt": "none" });
  try {
    assert.match((await ui(root, "catalog")).out, /no catalog/);
    assert.equal(existsSync(path.join(root, "docs/ui-catalog.md")), false);
    const config = { ...load(root), gates: { ...load(root).gates, "ui-catalog": true, "ui-dupes": true } };
    assert.deepEqual(await uiProblems(config), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qc ui find prints name, path and description of the nearest entries", async () => {
  const root = project(FILES);
  try {
    const { out } = await ui(root, "find", "pressable", "button");
    assert.equal(out, `Button — ${ROOT_UI}/button.tsx — A pressable control.`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qc ui codemod is a dry run until --write, and --suggest counts arbitrary values", async () => {
  const root = project(FILES);
  const map = JSON.stringify({ "text-[11px]": "text-2xs" });
  try {
    const dry = await ui(root, "codemod", "--map", map);
    assert.match(dry.out, /button\.tsx {2}1/);
    assert.match(dry.out, /2 token\(s\) in 2 file\(s\); a dry run/);
    assert.match(readFileSync(path.join(root, ROOT_UI, "button.tsx"), "utf8"), /text-\[11px\]/);
    await ui(root, "codemod", "--map", map, "--write");
    assert.match(readFileSync(path.join(root, ROOT_UI, "button.tsx"), "utf8"), /className="text-2xs rounded-\[4px\]"/);
    const suggestion = await ui(root, "codemod", "--suggest");
    assert.match(suggestion.out, /1 {2}rounded-\[4px\]/);
    assert.equal((await ui(root, "codemod")).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ui-catalog gate fails an undocumented component and a stale catalog, and a baseline excuses and then must shrink", async () => {
  const root = project(FILES);
  const gated = () => ({ ...load(root), gates: { ...load(root).gates, "ui-catalog": true } });
  try {
    await ui(root, "catalog");
    const first = (await uiProblems(gated())).filter((problem) => problem.rule.endsWith("component") || problem.rule.includes("catalog") || problem.rule.includes("baseline"));
    assert.deepEqual(first.map((problem) => [problem.rule, problem.path]), [["undocumented-component", `${ROOT_UI}/panel.tsx:1`]]);

    await ui(root, "catalog", "--baseline");
    assert.deepEqual((await uiProblems(gated())), []);

    writeFileSync(path.join(root, ROOT_UI, "panel.tsx"), `/** A panel. */\nexport const Panel = () => <div />;\n`);
    await ui(root, "catalog");
    const shrunk = (await uiProblems(gated()));
    assert.deepEqual(shrunk.map((problem) => problem.rule), ["stale-baseline"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ui-dupes gate fails a finding outside the baseline and the baseline only shrinks", async () => {
  const files = {
    [`${ROOT_UI}/a/card.tsx`]: "/** A card. */\nexport const Card = () => null;\n",
    [`${ROOT_UI}/b/card.tsx`]: "/** Another card. */\nexport const Card = () => null;\n",
  };
  const root = project(files);
  const gated = () => ({ ...load(root), gates: { ...load(root).gates, "ui-dupes": true } });
  try {
    assert.deepEqual((await uiProblems(gated())).map((problem) => problem.rule), ["duplicate-component-name"]);
    await ui(root, "dupes", "--baseline");
    assert.deepEqual((await uiProblems(gated())), []);
    rmSync(path.join(root, ROOT_UI, "b"), { recursive: true });
    assert.deepEqual((await uiProblems(gated())).map((problem) => problem.rule), ["stale-baseline"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
