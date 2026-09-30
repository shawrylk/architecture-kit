import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  agentTranscriptOf,
  agentTypeOf,
  contextOf,
  firstPromptOf,
  firstUsage,
  lastUsage,
  readRequests,
  requestOf,
  subagentTranscriptOf,
} from "./transcript-usage.mjs";

function folder(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-transcript-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

const usage = (read, write = 0, input = 2) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: 10,
});
const AT = "2026-01-01T00:00:00.000Z";
const assistant = (id, u, model = "claude-sonnet-5-5") => ({
  type: "assistant",
  timestamp: AT,
  message: { id, model, role: "assistant", content: [{ type: "text", text: "words" }], usage: u },
});
const user = (content) => ({ type: "user", message: { role: "user", content } });
function write(file, records) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`);
  return file;
}

test("contextOf adds fresh input, cache reads, and cache writes, and a missing usage is zero", () => {
  assert.equal(contextOf(usage(100, 20, 3)), 123);
  assert.equal(contextOf(null), 0);
  assert.equal(contextOf({}), 0);
});

test("requestOf keeps an assistant request with usage and drops every other line", () => {
  assert.deepEqual(requestOf(JSON.stringify(assistant("m1", usage(5)))), {
    id: "m1",
    model: "claude-sonnet-5-5",
    at: Date.parse(AT),
    usage: usage(5),
  });
  assert.equal(requestOf(JSON.stringify(user("hi"))), null);
  assert.equal(requestOf(JSON.stringify(assistant("m2", usage(5), "<synthetic>"))), null);
  assert.equal(requestOf('{"usage": broken'), null);
  assert.equal(requestOf(""), null);
});

test("readRequests counts one request once, though Claude Code writes a line per content block", (t) => {
  const base = folder(t);
  const file = write(path.join(base, "a.jsonl"), [
    user("go"),
    assistant("m1", usage(10)),
    assistant("m1", usage(10)),
    assistant("m2", usage(20)),
    '{"partial": "usage',
  ]);
  assert.deepEqual(readRequests(file).map((request) => request.id), ["m1", "m2"]);
  assert.deepEqual(readRequests(path.join(base, "missing.jsonl")), []);
});

test("firstUsage and lastUsage read one window at each end, and skip a line the window cuts", (t) => {
  const base = folder(t);
  const records = [
    user("go"),
    assistant("m1", usage(1000)),
    ...Array.from({ length: 200 }, (_, index) => assistant(`x${index}`, usage(5000 + index))),
    assistant("last", usage(9999)),
  ];
  const file = write(path.join(base, "a.jsonl"), records);
  assert.equal(contextOf(firstUsage(file)), 1002);
  assert.equal(contextOf(lastUsage(file)), 10001);
  const lastLine = JSON.stringify(records.at(-1));
  assert.equal(contextOf(lastUsage(file, lastLine.length + 10)), 10001);
  assert.equal(lastUsage(file, 20), null);
  const head = JSON.stringify(records[0]).length + 1 + JSON.stringify(records[1]).length + 5;
  assert.equal(contextOf(firstUsage(file, head)), 1002);
  assert.equal(firstUsage(file, 10), null);
  assert.equal(firstUsage(path.join(base, "missing.jsonl")), null);
  assert.equal(lastUsage(path.join(base, "missing.jsonl")), null);
});

test("firstPromptOf gives the first user message as text, from a string or from text blocks", (t) => {
  const base = folder(t);
  assert.equal(firstPromptOf(write(path.join(base, "a.jsonl"), [user("Brief: b.md\nEstimate: 12"), assistant("m1", usage(1))])), "Brief: b.md\nEstimate: 12");
  const blocks = user([{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }]);
  assert.equal(firstPromptOf(write(path.join(base, "b.jsonl"), [assistant("m1", usage(1)), blocks])), "one\n\ntwo");
  assert.equal(firstPromptOf(write(path.join(base, "c.jsonl"), [assistant("m1", usage(1))])), null);
  assert.equal(firstPromptOf(path.join(base, "missing.jsonl")), null);
});

test("a subagent's transcript is found however the hook input names it", (t) => {
  const base = folder(t);
  const main = path.join(base, "proj", "sess.jsonl");
  const own = subagentTranscriptOf(main, "a1");
  assert.equal(own, path.join(base, "proj", "sess", "subagents", "agent-a1.jsonl"));
  write(main, [user("hi")]);
  assert.equal(agentTranscriptOf({ agent_id: "a1", transcript_path: main }), null, "no file yet");
  write(own, [user("go")]);
  assert.equal(agentTranscriptOf({ agent_id: "a1", transcript_path: main }), own);
  assert.equal(agentTranscriptOf({ agent_id: "a1", transcript_path: own }), own);
  const named = write(path.join(base, "elsewhere", "agent-a1.jsonl"), [user("go")]);
  assert.equal(agentTranscriptOf({ agent_id: "a1", agent_transcript_path: named, transcript_path: main }), named);
  assert.equal(agentTranscriptOf({ transcript_path: main }), null, "the main session has no agent id");
  assert.equal(agentTranscriptOf({ agent_id: "a1" }), null);
});

test("an agent_transcript_path to a missing file falls back to the subagents path, and then to null", (t) => {
  const base = folder(t);
  const main = path.join(base, "proj", "sess.jsonl");
  const missing = path.join(base, "proj", "gone", "agent-a1.jsonl");
  write(main, [user("hi")]);
  assert.equal(agentTranscriptOf({ agent_id: "a1", agent_transcript_path: missing, transcript_path: main }), null, "no file anywhere");
  assert.equal(agentTranscriptOf({ agent_id: "a1", agent_transcript_path: missing }), null, "no main transcript either");
  const own = write(subagentTranscriptOf(main, "a1"), [user("go")]);
  assert.equal(agentTranscriptOf({ agent_id: "a1", agent_transcript_path: missing, transcript_path: main }), own);
});

test("agentTypeOf reads the type from the meta file beside a transcript", (t) => {
  const base = folder(t);
  const file = write(path.join(base, "agent-a1.jsonl"), [user("go")]);
  assert.equal(agentTypeOf(file), null);
  writeFileSync(path.join(base, "agent-a1.meta.json"), JSON.stringify({ agentType: "architecture:sdd-reviewer" }));
  assert.equal(agentTypeOf(file), "architecture:sdd-reviewer");
});
