import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkCommitAttribution, withoutAttribution } from "./commit-attribution.mjs";

const plain = "fix(photos): the timeline rests groups below the sticky header\n\nThe seek landed under it.\n";

test("an ordinary message passes", () => {
  assert.deepEqual(checkCommitAttribution(plain), []);
});

test("a Claude co-author trailer is refused", () => {
  const [problem] = checkCommitAttribution(`${plain}\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n`);
  assert.equal(problem.rule, "tool-as-author");
  assert.match(problem.detail, /A tool is not an author/);
});

test("other assistants are refused by the same rule", () => {
  for (const tool of ["Copilot <bot@github.com>", "ChatGPT <x@openai.com>", "Cursor <a@cursor.sh>", "Devin <d@cognition.ai>"]) {
    assert.equal(checkCommitAttribution(`${plain}\nCo-Authored-By: ${tool}\n`).length, 1, tool);
  }
});

test("a human co-author is never refused", () => {
  assert.deepEqual(checkCommitAttribution(`${plain}\nCo-Authored-By: Hieu Nguyen <hieu.nguyen@arent3d.com>\n`), []);
});

test("the marketing footer is refused too, trailer or not", () => {
  const [problem] = checkCommitAttribution(`${plain}\n🤖 Generated with Claude Code\n`);
  assert.equal(problem.rule, "tool-footer");
});

test("stripping leaves the message intact and the trailers gone", () => {
  const dirty = `${plain}\nCo-Authored-By: Claude <noreply@anthropic.com>\n🤖 Generated with Claude Code\n`;
  const clean = withoutAttribution(dirty);
  assert.deepEqual(checkCommitAttribution(clean), []);
  assert.match(clean, /timeline rests groups/);
  assert.doesNotMatch(clean, /Claude/);
});

test("stripping a message that needs nothing changes nothing but the trailing newline", () => {
  assert.equal(withoutAttribution(plain).trim(), plain.trim());
});

test("a Signed-off-by from a person survives, from a tool does not", () => {
  assert.deepEqual(checkCommitAttribution(`${plain}\nSigned-off-by: Hieu <h@arent3d.com>\n`), []);
  assert.equal(checkCommitAttribution(`${plain}\nSigned-off-by: Claude <noreply@anthropic.com>\n`).length, 1);
});
