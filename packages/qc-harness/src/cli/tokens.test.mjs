import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RATES, claudeDirOf, costsOf, projectKeyOf, runTokens, sessionFiles, summarizeSession } from "./tokens.mjs";
import { readRequests } from "./transcript-usage.mjs";

const MINUTE = 60_000;
const req = (id, minute, read, write, { input = 2, model = "m", w1h = 0 } = {}) => ({
  id,
  model,
  at: minute * MINUTE,
  usage: {
    input_tokens: input,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cache_creation: { ephemeral_5m_input_tokens: write - w1h, ephemeral_1h_input_tokens: w1h },
    output_tokens: 5,
  },
});

test("with no gap past five minutes, the one-hour lifetime only raises the write price", () => {
  const { cost, cost1h, gapMisses } = costsOf([req("a", 0, 0, 1000), req("b", 1, 1000, 100)]);
  assert.equal(cost, 1000 * 1.25 + 2 + 1000 * 0.1 + 100 * 1.25 + 2);
  assert.equal(cost1h, 1000 * 2 + 2 + 1000 * 0.1 + 100 * 2 + 2);
  assert.equal(gapMisses, 0);
});

test("a miss after a gap of five minutes to an hour becomes a read of the old context at one hour", () => {
  const { cost, cost1h, gapMisses } = costsOf([req("a", 0, 0, 1000), req("b", 10, 0, 1100)]);
  assert.equal(gapMisses, 1);
  assert.equal(cost, 1000 * 1.25 + 2 + 1100 * 1.25 + 2);
  // The second request re-sent 1,002 tokens it had sent before; only its 100 new ones are written.
  assert.equal(cost1h, 1000 * 2 + 2 + (1100 - 100) * 0.1 + 100 * 2 + 2);
  assert.ok(cost1h < cost);
});

test("a gap past an hour misses at either lifetime", () => {
  const { cost1h, gapMisses } = costsOf([req("a", 0, 0, 1000), req("b", 90, 0, 1100)]);
  assert.equal(gapMisses, 1);
  assert.equal(cost1h, 1000 * 2 + 2 + 1100 * 2 + 2);
});

test("an observed one-hour write is priced as one", () => {
  const { cost } = costsOf([req("a", 0, 0, 1000, { w1h: 1000 })]);
  assert.equal(cost, 1000 * 2 + 2);
});

test("summarizeSession adds each type's agents, and lists main first, then by tokens read", () => {
  const { types, total } = summarizeSession({
    main: [req("m1", 0, 0, 500), req("m2", 1, 500, 50)],
    agents: [
      { type: "impl", requests: [req("i1", 0, 0, 1000), req("i2", 1, 1000, 100), req("i3", 2, 1100, 100)] },
      { type: "impl", requests: [req("j1", 3, 800, 200), req("j2", 4, 1000, 100)] },
      { type: "rev", requests: [req("r1", 0, 0, 300)] },
    ],
  });
  assert.deepEqual(types.map((stats) => stats.type), ["main", "impl", "rev"]);
  const impl = types[1];
  assert.equal(impl.agents, 2);
  assert.equal(impl.calls, 5);
  assert.equal(impl.read, 0 + 1000 + 1100 + 800 + 1000);
  assert.equal(impl.write5m, 1000 + 100 + 100 + 200 + 100);
  assert.equal(impl.maxContext, 1100 + 100 + 2);
  assert.equal(impl.hitRate, impl.read / (impl.read + impl.write5m + impl.write1h + impl.input));
  assert.equal(impl.firstMedian, 1002);
  assert.equal(total.calls, 2 + 5 + 1);
  assert.equal(total.read, types.reduce((sum, stats) => sum + stats.read, 0));
});

test("a first call that missed a shared prefix warmed 5 to 60 minutes before reads it at one hour", () => {
  const agents = [
    { type: "rev", requests: [req("a", 0, 0, 1000)] },
    { type: "rev", requests: [req("b", 2, 800, 200)] },
    { type: "rev", requests: [req("c", 20, 0, 1000)] },
  ];
  const [stats] = summarizeSession({ agents }).types;
  const plain = agents.reduce((sum, agent) => sum + costsOf(agent.requests).cost1h, 0);
  assert.equal(stats.cost1h, plain - 800 * (RATES.write1h - RATES.read));
  assert.equal(stats.prefixes, 1);
});

test("two first-call prefixes of one model in one session count as two", () => {
  const agents = [
    { type: "rev", requests: [req("a", 0, 800, 200)] },
    { type: "rev", requests: [req("b", 1, 900, 200)] },
    { type: "rev", requests: [req("c", 2, 700, 200, { model: "other" })] },
  ];
  assert.equal(summarizeSession({ agents }).types[0].prefixes, 2);
});

test("an empty session sums to zero without dividing by zero", () => {
  const { types, total } = summarizeSession({ main: [], agents: [] });
  assert.deepEqual(types, []);
  assert.equal(total.hitRate, 0);
  assert.equal(total.whatIf1h, 0);
});

test("a call that writes as much as it reads after a long gap is no miss", () => {
  const { gapMisses, cost1h } = costsOf([req("a", 0, 0, 1000), req("b", 10, 500, 500)]);
  assert.equal(gapMisses, 0);
  assert.equal(cost1h, 1000 * 2 + 2 + 500 * 0.1 + 500 * 2 + 2);
});

test("a call that writes more than it reads after a gap under five minutes is no miss", () => {
  const { gapMisses, cost1h } = costsOf([req("a", 0, 0, 1000), req("b", 1, 0, 1100)]);
  assert.equal(gapMisses, 0);
  assert.equal(cost1h, 1000 * 2 + 2 + 1100 * 2 + 2);
});

test("a shared prefix warmed more than an hour before earns no one-hour credit", () => {
  const agents = [
    { type: "rev", requests: [req("a", 0, 0, 1000)] },
    { type: "rev", requests: [req("b", 2, 800, 200)] },
    { type: "rev", requests: [req("c", 100, 0, 1000)] },
  ];
  const [stats] = summarizeSession({ agents }).types;
  assert.equal(stats.cost1h, agents.reduce((sum, agent) => sum + costsOf(agent.requests).cost1h, 0));
});

test("the credit for a shared prefix holds at exactly one hour and not at exactly five minutes", () => {
  const credited = (gap) => {
    const agents = [
      { type: "rev", requests: [req("a", 0, 800, 200)] },
      { type: "rev", requests: [req("b", gap, 0, 1000)] },
    ];
    const [stats] = summarizeSession({ agents }).types;
    return stats.cost1h < agents.reduce((sum, agent) => sum + costsOf(agent.requests).cost1h, 0);
  };
  assert.equal(credited(5), false);
  assert.equal(credited(60), true);
  assert.equal(credited(61), false);
});

test("the total keeps the largest context and the summed one-hour cost, and takes no credit of its own", () => {
  const { types, total } = summarizeSession({
    main: [req("m1", 0, 0, 500), req("m2", 1, 500, 5000)],
    agents: [
      { type: "rev", requests: [req("a", 0, 0, 1000)] },
      { type: "rev", requests: [req("b", 2, 800, 200)] },
      { type: "rev", requests: [req("c", 20, 0, 1000)] },
    ],
  });
  assert.equal(total.maxContext, 500 + 5000 + 2);
  assert.equal(total.cost1h, types.reduce((sum, stats) => sum + stats.cost1h, 0));
  assert.equal(total.whatIf1h, (total.cost1h - total.cost) / total.cost);
  const rev = types.find((stats) => stats.type === "rev");
  const plain = costsOf([req("a", 0, 0, 1000)]).cost1h + costsOf([req("b", 2, 800, 200)]).cost1h + costsOf([req("c", 20, 0, 1000)]).cost1h;
  assert.equal(rev.cost1h, plain - 800 * (RATES.write1h - RATES.read), "the shared prefix credit is in the type, once");
});

const line = (id, minute, read, write) =>
  JSON.stringify({
    type: "assistant",
    timestamp: new Date(minute * 60_000).toISOString(),
    message: { id, model: "claude-sonnet-5-5", role: "assistant", content: [], usage: { input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 5 } },
  });

test("totals on a transcript with a line per content block count each request once", (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-tokens-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, "agent-a1.jsonl");
  const lines = [line("i1", 0, 0, 1000), line("i1", 0, 0, 1000), line("i2", 1, 1000, 100), line("i2", 1, 1000, 100), line("i2", 1, 1000, 100)];
  writeFileSync(file, `${lines.join("\n")}\n`);
  const { types, total } = summarizeSession({ agents: [{ type: "impl", requests: readRequests(file) }] });
  assert.equal(types[0].calls, 2);
  assert.equal(types[0].read, 1000);
  assert.equal(types[0].write5m, 1100);
  assert.equal(total.calls, 2);
  assert.equal(total.output, 10);
});

function claudeDir(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-tokens-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

/** A fake Claude Code folder with one project, a newer session `s1` (a main transcript and two subagents), and an older one `s0`. */
function fakeSession(t) {
  const dir = claudeDir(t);
  const project = path.join(dir, "repo");
  const projectDir = path.join(dir, "projects", projectKeyOf(project));
  const subagents = path.join(projectDir, "s1", "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(path.join(projectDir, "s1.jsonl"), `${line("m1", 0, 0, 500)}\n`);
  writeFileSync(path.join(subagents, "agent-a1.jsonl"), `${line("i1", 0, 0, 1000)}\n${line("i1", 0, 0, 1000)}\n${line("i2", 1, 1000, 100)}\n`);
  writeFileSync(path.join(subagents, "agent-a1.meta.json"), JSON.stringify({ agentType: "architecture:sdd-implementer" }));
  writeFileSync(path.join(subagents, "agent-a2.jsonl"), `${line("r1", 2, 0, 300)}\n`);
  writeFileSync(path.join(subagents, "notes.jsonl"), `${line("z1", 3, 0, 9)}\n`);
  const older = path.join(projectDir, "s0.jsonl");
  writeFileSync(older, `${line("o1", 0, 0, 77)}\n`);
  utimesSync(older, new Date("2020-01-01"), new Date("2020-01-01"));
  return { dir, project, projectDir };
}

test("the project key replaces each character outside letters and digits with a dash", () => {
  if (process.platform === "win32") assert.equal(projectKeyOf("C:\\Users\\x\\qc-mono"), "C--Users-x-qc-mono");
  else assert.equal(projectKeyOf("/home/u/qc-mono"), "-home-u-qc-mono");
});

test("the project key keeps a digit", () => {
  assert.match(projectKeyOf(path.join(os.tmpdir(), "repo2")), /repo2$/);
});

test("the project key of a link to a folder is the key of the folder", (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-tokens-link-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const target = path.join(base, "target");
  mkdirSync(target);
  const link = path.join(base, "link");
  symlinkSync(target, link, "junction");
  assert.equal(projectKeyOf(link), projectKeyOf(target));
});

test("the project key of a short 8.3 path is the key of its long path", () => {
  assert.equal(projectKeyOf(os.tmpdir()), projectKeyOf(realpathSync.native(os.tmpdir())));
});

test("the project key of a path that does not exist is built from the path as given", (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-tokens-none-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const missing = path.join(base, "not-there");
  assert.equal(projectKeyOf(missing), path.resolve(missing).replace(/[^A-Za-z0-9]/g, "-"));
});

test("the Claude folder is the environment's, else the home folder's", () => {
  assert.equal(claudeDirOf({ CLAUDE_CONFIG_DIR: "/somewhere" }), "/somewhere");
  assert.equal(claudeDirOf({}), path.join(os.homedir(), ".claude"));
});

test("sessionFiles finds the newest session's main transcript and each subagent transcript", (t) => {
  const { dir, project } = fakeSession(t);
  const files = sessionFiles({ claudeDir: dir, project });
  assert.equal(files.id, "s1");
  assert.ok(files.main.endsWith("s1.jsonl"));
  assert.deepEqual(files.agents.map((file) => path.basename(file)).sort(), ["agent-a1.jsonl", "agent-a2.jsonl"]);
  assert.equal(sessionFiles({ claudeDir: dir, project: path.join(dir, "elsewhere") }), null);
});

test("a stray file in the subagents folder is not read as a subagent transcript", (t) => {
  const { dir, project, projectDir } = fakeSession(t);
  const subagents = path.join(projectDir, "s1", "subagents");
  for (const stray of ["agent-notes.txt", "xagent-1.jsonl", "agent-a3.jsonl.bak"]) writeFileSync(path.join(subagents, stray), `${line("z", 4, 0, 9)}\n`);
  const files = sessionFiles({ claudeDir: dir, project });
  assert.deepEqual(files.agents.map((file) => path.basename(file)).sort(), ["agent-a1.jsonl", "agent-a2.jsonl"]);
});

test("sessionFiles reads a named session even when a newer one exists", (t) => {
  const { dir, project } = fakeSession(t);
  const files = sessionFiles({ claudeDir: dir, project, session: "s0" });
  assert.equal(files.id, "s0");
  assert.deepEqual(files.agents, []);
});

test("a session with subagents and no main transcript has no main, and one with neither is not found", (t) => {
  const { dir, project, projectDir } = fakeSession(t);
  mkdirSync(path.join(projectDir, "s2", "subagents"), { recursive: true });
  writeFileSync(path.join(projectDir, "s2", "subagents", "agent-b1.jsonl"), `${line("b1", 0, 0, 5)}\n`);
  const headless = sessionFiles({ claudeDir: dir, project, session: "s2" });
  assert.equal(headless.main, null);
  assert.equal(headless.agents.length, 1);
  assert.equal(sessionFiles({ claudeDir: dir, project, session: "ghost" }), null);
});

test("qc tokens --session reads that session, and --project names the project, not the config root", (t) => {
  const { dir, project } = fakeSession(t);
  const lines = [];
  const code = runTokens({ root: path.join(dir, "elsewhere") }, ["--claude-dir", dir, "--project", project, "--session", "s0", "--json"], (text) => lines.push(text));
  assert.equal(code, 0);
  const report = JSON.parse(lines.join("\n"));
  assert.equal(report.session, "s0");
  assert.deepEqual(report.types.map((stats) => stats.type), ["main"]);
  assert.equal(report.types[0].write5m, 77);
});

test("qc tokens --json reports each type once per request, and an agent with no meta as unknown", (t) => {
  const { dir, project } = fakeSession(t);
  const lines = [];
  const code = runTokens({ root: project }, ["--claude-dir", dir, "--json"], (text) => lines.push(text));
  assert.equal(code, 0);
  const report = JSON.parse(lines.join("\n"));
  assert.equal(report.session, "s1");
  const byType = Object.fromEntries(report.types.map((stats) => [stats.type, stats]));
  assert.deepEqual(Object.keys(byType), ["main", "architecture:sdd-implementer", "unknown"]);
  assert.equal(byType["architecture:sdd-implementer"].calls, 2);
  assert.equal(byType.unknown.calls, 1);
});

test("qc tokens prints a table with a footer that names the rates", (t) => {
  const { dir, project } = fakeSession(t);
  const lines = [];
  assert.equal(runTokens({ root: project }, ["--claude-dir", dir, "--session", "s1"], (text) => lines.push(text)), 0);
  const text = lines.join("\n");
  assert.match(text, /architecture:sdd-implementer/);
  assert.match(text, /total/);
  assert.match(text, /API list prices/);
  assert.match(text, /subagentPromptCacheTtl/);
});

test("qc tokens with no session to read says so and exits 1", (t) => {
  const dir = claudeDir(t);
  const errors = [];
  assert.equal(runTokens({ root: path.join(dir, "none") }, ["--claude-dir", dir], () => {}, (text) => errors.push(text)), 1);
  assert.match(errors.join("\n"), /no session/);
});
