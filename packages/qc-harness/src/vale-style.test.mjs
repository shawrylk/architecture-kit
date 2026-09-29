import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { load } from "./config.mjs";
import { runInit } from "./cli/init.mjs";

const vale = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates/vale");
const style = path.join(vale, "styles/Qc");
const rules = Object.fromEntries(
  readdirSync(style)
    .filter((file) => file.endsWith(".yml"))
    .map((file) => [file.replace(/\.yml$/, ""), parse(readFileSync(path.join(style, file), "utf8"))]),
);

test("the errors are utilize, in order to, the Latin abbreviations, please, and/or, and progress phrases", () => {
  for (const name of ["Utilize", "InOrderTo", "Latin", "Please", "AndOr", "Progress"]) {
    assert.equal(rules[name]?.level, "error", name);
  }
  assert.match(rules.Progress.tokens.join("|"), /not yet.*for now.*the next phase/);
});

test("sentence length and passive voice are warnings, and a sentence holds 25 words at most", () => {
  assert.equal(rules.SentenceLength.level, "warning");
  assert.equal(rules.SentenceLength.max, 25);
  assert.equal(rules.PassiveVoice.level, "warning");
});

test("the Vale config applies the Qc style to markdown and needs no package", () => {
  const ini = readFileSync(path.join(vale, ".vale.ini"), "utf8");
  assert.match(ini, /^StylesPath = styles$/m);
  assert.match(ini, /BasedOnStyles = Qc/);
  assert.doesNotMatch(ini, /^Packages\s*=/m);
});

const installed = spawnSync("vale", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;

test("vale reports each banned phrase at its line", { skip: !installed && "the vale binary is not on PATH" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vale-style-"));
  try {
    const file = path.join(dir, "sample.md");
    writeFileSync(
      file,
      ["# Title", "", "Please utilize it in order to win.", "Use e.g. this, and/or that.", "It is not yet done.", "`utilize` in code is fine."].join("\n"),
    );
    const run = spawnSync("vale", [`--config=${path.join(vale, ".vale.ini")}`, "--output=JSON", "--no-exit", file], { encoding: "utf8", windowsHide: true });
    const alerts = Object.values(JSON.parse(run.stdout)).flat();
    const seen = alerts.map((alert) => `${alert.Line}:${alert.Check}`);
    for (const expected of ["3:Qc.Please", "3:Qc.Utilize", "3:Qc.InOrderTo", "4:Qc.Latin", "4:Qc.AndOr", "5:Qc.Progress"]) {
      assert.ok(seen.includes(expected), `${expected} in ${seen.join(", ")}`);
    }
    assert.ok(!seen.some((entry) => entry.startsWith("6:")), "inline code is not linted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init copies the Vale config and every rule where qc prose looks for them", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vale-init-"));
  const log = console.log;
  console.log = () => {};
  try {
    await runInit(load(dir));
    assert.ok(existsSync(path.join(dir, ".vale/.vale.ini")));
    for (const rule of Object.keys(rules)) assert.ok(existsSync(path.join(dir, ".vale/styles/Qc", `${rule}.yml`)), rule);
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the template workflow runs qc prose on a pull request, with a pinned Vale release", () => {
  const workflow = readFileSync(path.join(vale, "../github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /releases\/download\/v\d+\.\d+\.\d+\/vale_/);
  assert.match(workflow, /npx qc prose --pr-body-event/);
});
