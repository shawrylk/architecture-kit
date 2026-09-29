import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { defaults, load, merge } from "./config.mjs";
import { runInit } from "./cli/init.mjs";
import { checkProse, runVale } from "./cli/prose.mjs";

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
  assert.equal(rules.Progress.tokens.length, 4);
  // A phrase may wrap at a line break, so no phrase holds a literal space.
  for (const name of ["InOrderTo", "Progress"]) {
    for (const token of rules[name].tokens) assert.ok(!token.includes(" ") && token.includes("+"), `${name}: ${token}`);
  }
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
      [
        "# Title", // 1
        "", // 2
        "Please utilize it in order to win.", // 3
        "Use e.g. this, and/or that.", // 4
        "It is not yet done.", // 5
        "`utilize` in code is fine.", // 6
        "Say it, i.e. this.", // 7
        "Add tea and milk, etc. to it.", // 8
        "The report was written by the team.", // 9
        "", // 10
        "The tool works in", // 11
        "order to win, and it is not", // 12
        "yet done.", // 13
      ].join("\n"),
    );
    const run = spawnSync("vale", [`--config=${path.join(vale, ".vale.ini")}`, "--output=JSON", "--no-exit", file], { encoding: "utf8", windowsHide: true });
    const alerts = Object.values(JSON.parse(run.stdout)).flat();
    const seen = alerts.map((alert) => `${alert.Line}:${alert.Check}`);
    const expected = [
      "3:Qc.Please", "3:Qc.Utilize", "3:Qc.InOrderTo", "4:Qc.Latin", "4:Qc.AndOr", "5:Qc.Progress",
      "7:Qc.Latin", "8:Qc.Latin", "9:Qc.PassiveVoice",
      // A phrase that a line break splits is reported at the line where it starts.
      "11:Qc.InOrderTo", "12:Qc.Progress",
    ];
    for (const entry of expected) assert.ok(seen.includes(entry), `${entry} in ${seen.join(", ")}`);
    assert.ok(!seen.some((entry) => entry.startsWith("6:")), "inline code is not linted");
    assert.equal(alerts.find((alert) => alert.Line === 7)?.Match, "i.e.");
    assert.match(alerts.find((alert) => alert.Line === 8 && alert.Check === "Qc.Latin")?.Match ?? "", /^etc\.?$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qc prose keeps the alerts of a real Vale run, whatever spelling of the path Vale prints", { skip: !installed && "the vale binary is not on PATH" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vale-prose-"));
  try {
    writeFileSync(path.join(dir, "a.md"), "Old line.\nPlease new.\n");
    const { problems } = await checkProse({ ...merge(defaults, {}), root: dir }, { added: [{ path: "a.md", line: 2, text: "Please new." }], vale: runVale, ci: true });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /a\.md:2 {2}Qc\.Please/);
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

const HASH = "fbc2eb47d0b8c50220ed1a2c5c611fbe0904ed567d638143d482016a18fd2db0";
const TARBALL = "vale_3.9.1_Linux_64-bit.tar.gz";
const templateWorkflow = readFileSync(path.join(vale, "../github/workflows/ci.yml"), "utf8");
const kitWorkflow = readFileSync(path.resolve(vale, "../../../../.github/workflows/ci.yml"), "utf8");

/** @returns the `run` script of the step that installs Vale in `text`. */
function installStep(text) {
  const steps = Object.values(parse(text).jobs).flatMap((job) => job.steps ?? []);
  return steps.find((step) => /releases\/download/.test(step.run ?? ""))?.run ?? "";
}

test("the template workflow runs qc prose on a pull request, with a pinned Vale release", () => {
  assert.match(templateWorkflow, /releases\/download\/v\d+\.\d+\.\d+\/vale_/);
  assert.match(templateWorkflow, /npx qc prose --base "origin\/\$GITHUB_BASE_REF" --pr-body-event/);
});

test("a pull request event that edits the body runs the check again", () => {
  const { on } = parse(templateWorkflow);
  assert.deepEqual([...on.pull_request.types].sort(), ["edited", "opened", "reopened", "synchronize"]);
});

test("every workflow checks the Vale tarball against its hash before it extracts", () => {
  for (const text of [templateWorkflow, kitWorkflow]) {
    const script = installStep(text);
    assert.ok(script.includes(`${HASH}  ${TARBALL}`), "the pinned hash");
    const check = script.indexOf("sha256sum -c");
    assert.ok(check > 0, "a sha256sum -c step");
    assert.ok(check < script.indexOf("tar "), "the check runs before tar");
    assert.doesNotMatch(script, /\|\s*tar/, "the download is not piped into tar");
  }
});

test("the kit's own CI installs Vale on the ubuntu leg, so the real-Vale test runs", () => {
  const steps = Object.values(parse(kitWorkflow).jobs).flatMap((job) => job.steps ?? []);
  const install = steps.find((step) => /releases\/download/.test(step.run ?? ""));
  assert.ok(install, "an install step");
  assert.match(install.if ?? "", /ubuntu/);
  const order = steps.indexOf(install);
  assert.ok(order < steps.findIndex((step) => step.run === "pnpm test"), "Vale is installed before the tests run");
});

test("the README and the enforcement page state that an alert lands on the line where a sentence starts", () => {
  const readme = readFileSync(path.resolve(vale, "../../../../README.md"), "utf8");
  const enforcement = readFileSync(path.join(vale, "../docs/enforcement.md"), "utf8");
  for (const text of [readme, enforcement]) assert.match(text.replace(/\s+/g, " "), /alert lands on the line where the sentence or phrase starts, so an edit to a later line of it is not judged/);
});
