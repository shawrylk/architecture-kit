import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaults, merge } from "../config.mjs";
import { checkProse, runProse } from "./prose.mjs";

const config = (root) => ({ ...merge(defaults, {}), root });

/** A stand-in for Vale: it flags the words the style forbids, as Vale's JSON output reports them. */
const RULES = [
  { check: "Qc.Utilize", severity: "error", pattern: /\butilize\b/i, message: "Use 'use' instead of 'utilize'." },
  { check: "Qc.Please", severity: "error", pattern: /\bplease\b/i, message: "Do not write 'please' in an instruction." },
  { check: "Qc.SentenceLength", severity: "warning", pattern: /(\S+\s+){25}\S+/, message: "Write 25 words or fewer." },
];
function fakeVale(calls = []) {
  return async (args, { cwd }) => {
    const files = args.filter((arg) => !arg.startsWith("--"));
    calls.push(files);
    const out = {};
    for (const file of files) {
      const lines = readFileSync(path.resolve(cwd, file), "utf8").split("\n");
      out[file] = lines.flatMap((text, index) =>
        RULES.filter((rule) => rule.pattern.test(text)).map((rule) => ({
          Check: rule.check,
          Severity: rule.severity,
          Message: rule.message,
          Line: index + 1,
          Span: [1, 2],
        })),
      );
    }
    return { ok: true, stdout: JSON.stringify(out) };
  };
}
const missingVale = async () => ({ ok: false, missing: true, stderr: "spawn vale ENOENT" });

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
/** A repository whose `main` holds `before`, and whose `topic` branch holds `after`; each maps a path to its text. */
function repo(before, after) {
  const root = mkdtempSync(path.join(tmpdir(), "prose-"));
  git(root, "init", "-q", "-b", "main");
  const write = (files) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
  };
  write(before);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "topic");
  write(after);
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "topic");
  return root;
}
/** Runs `runProse` in `root` with the given argument list, and returns the exit code and both output streams. */
async function run(root, args, options = {}) {
  const lines = { out: [], err: [] };
  const log = console.log;
  const error = console.error;
  console.log = (line) => lines.out.push(line);
  console.error = (line) => lines.err.push(line);
  try {
    const code = await runProse(config(root), args, { env: {}, vale: fakeVale(), base: "main", ...options });
    return { code, out: lines.out.join("\n"), err: lines.err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}
/** Runs the body of a test in a repository, and removes the repository afterwards. */
async function inRepo(before, after, body) {
  const root = repo(before, after);
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an added line with 'please utilize' fails", async () => {
  await inRepo({ "docs/a.md": "# A\n" }, { "docs/a.md": "# A\nPlease utilize the map.\n" }, async (root) => {
    const { code, err } = await run(root, []);
    assert.equal(code, 1);
    assert.match(err, /docs\/a\.md:2/);
    assert.match(err, /Qc\.Utilize/);
    assert.match(err, /Qc\.Please/);
  });
});

test("an unchanged old line with the same words does not", async () => {
  await inRepo({ "docs/a.md": "Please utilize the map.\n" }, { "docs/a.md": "Please utilize the map.\nA clean new line.\n" }, async (root) => {
    const { code, err } = await run(root, []);
    assert.equal(code, 0, err);
    assert.equal(err, "");
  });
});

test("an ADR path, a changelog and a session report are exempt", async () => {
  const bad = "Please utilize the map.\n";
  const after = { "docs/decisions/0001-x.md": bad, "docs/decisions.md": bad, "CHANGELOG.md": bad, "docs/reports/s1.md": bad };
  await inRepo({ "README.md": "# R\n" }, after, async (root) => {
    const calls = [];
    const { code, err } = await run(root, [], { vale: fakeVale(calls) });
    assert.equal(code, 0, err);
    assert.deepEqual(calls, []);
  });
});

test("a file outside prose.paths is not linted", async () => {
  await inRepo({ "README.md": "# R\n" }, { "src/notes.md": "Please utilize the map.\n" }, async (root) => {
    assert.equal((await run(root, [])).code, 0);
  });
});

test("a warning is printed and never fails", async () => {
  const long = Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ");
  await inRepo({ "docs/a.md": "# A\n" }, { "docs/a.md": `# A\n${long}\n` }, async (root) => {
    const { code, out } = await run(root, []);
    assert.equal(code, 0);
    assert.match(out, /WARN\s+prose\s+docs\/a\.md:2\s+Qc\.SentenceLength/);
  });
});

test("a missing vale binary is a note, not a failure, outside CI", async () => {
  await inRepo({ "docs/a.md": "# A\n" }, { "docs/a.md": "# A\nPlease utilize the map.\n" }, async (root) => {
    const { code, out } = await run(root, [], { vale: missingVale });
    assert.equal(code, 0);
    assert.match(out, /NOTE\s+prose.*vale/i);
  });
});

test("a missing vale binary fails in CI", async () => {
  await inRepo({ "docs/a.md": "# A\n" }, { "docs/a.md": "# A\nA clean line.\n" }, async (root) => {
    const { code, err } = await run(root, [], { vale: missingVale, env: { CI: "true" } });
    assert.equal(code, 1);
    assert.match(err, /FAIL\s+prose.*vale is not installed/i);
  });
});

test("a change with no prose in scope does not need vale", async () => {
  await inRepo({ "src/a.ts": "a\n" }, { "src/a.ts": "b\n" }, async (root) => {
    const { code, out } = await run(root, [], { vale: missingVale, env: { CI: "true" } });
    assert.equal(code, 0);
    assert.match(out, /OK\s+prose/);
  });
});

test("a base ref that git cannot read fails in CI and is a note elsewhere", async () => {
  await inRepo({ "docs/a.md": "# A\n" }, { "docs/a.md": "# A\nx\n" }, async (root) => {
    const ci = await run(root, ["--base", "origin/nope"], { env: { CI: "1" } });
    assert.equal(ci.code, 1);
    assert.match(ci.err, /origin\/nope/);
    const local = await run(root, ["--base", "origin/nope"]);
    assert.equal(local.code, 0);
    assert.match(local.out, /NOTE\s+prose.*origin\/nope/);
  });
});

test("a PR body is linted whole, from a file or from the event", async () => {
  await inRepo({ "README.md": "# R\n" }, { "README.md": "# R\n" }, async (root) => {
    writeFileSync(path.join(root, "body.md"), "Fixes #3\n\nPlease utilize the map.\n");
    const fromFile = await run(root, ["--pr-body", "body.md"]);
    assert.equal(fromFile.code, 1);
    assert.match(fromFile.err, /PR body:3/);

    const eventPath = path.join(root, "event.json");
    const env = { GITHUB_EVENT_PATH: eventPath };
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 3, body: "Fixes #3\n\nA clean body.\n" } }));
    const clean = await run(root, ["--pr-body-event"], { env });
    assert.equal(clean.code, 0, clean.err);
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 3, body: "Utilize it." } }));
    const dirty = await run(root, ["--pr-body-event"], { env });
    assert.equal(dirty.code, 1);
    assert.match(dirty.err, /PR body:1/);
  });
});

test("--pr-body-event outside a pull request event is a note", async () => {
  await inRepo({ "README.md": "# R\n" }, { "README.md": "# R\n" }, async (root) => {
    const { code, out } = await run(root, ["--pr-body-event"], { env: {} });
    assert.equal(code, 0);
    assert.match(out, /NOTE\s+prose.*no pull request/i);
  });
});

test("checkProse keeps only the alerts on added lines", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "prose-"));
  try {
    writeFileSync(path.join(root, "a.md"), "Please old.\nPlease new.\n");
    const added = [{ path: "a.md", line: 2, text: "Please new." }];
    const { problems } = await checkProse(config(root), { added, vale: fakeVale(), ci: false });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /a\.md:2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
