import assert from "node:assert/strict";
import test from "node:test";
import { CORE_BEGIN, CORE_END, applyBlock } from "./setup-block.mjs";

test("exports the core marker lines", () => {
  assert.equal(CORE_BEGIN, "<!-- architecture-kit:begin core -->");
  assert.equal(CORE_END, "<!-- architecture-kit:end core -->");
});

test("writes the block into empty text", () => {
  assert.deepEqual(applyBlock("", "body"), {
    text: `${CORE_BEGIN}\nbody\n${CORE_END}\n`,
    changed: true,
  });
});

test("appends the block after a blank line", () => {
  assert.deepEqual(applyBlock("mine\n", "body"), {
    text: `mine\n\n${CORE_BEGIN}\nbody\n${CORE_END}\n`,
    changed: true,
  });
});

test("adds the missing final newline before the blank line", () => {
  assert.equal(applyBlock("mine", "body").text,
    `mine\n\n${CORE_BEGIN}\nbody\n${CORE_END}\n`);
});

test("replaces the block and preserves every character outside the marker lines", () => {
  const before = "  mine \t\n\n";
  const after = "\n\tmy footer  \n\n";
  const text = `${before}${CORE_BEGIN}\nold body\n${CORE_END}${after}`;
  assert.deepEqual(applyBlock(text, "new body"), {
    text: `${before}${CORE_BEGIN}\nnew body\n${CORE_END}${after}`,
    changed: true,
  });
});

test("leaves the second call unchanged", () => {
  const first = applyBlock("mine\n", "body");
  assert.deepEqual(applyBlock(first.text, "body"), {
    text: first.text,
    changed: false,
  });
});

test("uses CRLF inside and around the appended block", () => {
  const result = applyBlock("mine\r\n", "first\nsecond\r\nthird  \n\t");
  assert.equal(result.text,
    `mine\r\n\r\n${CORE_BEGIN}\r\nfirst\r\nsecond\r\nthird\r\n${CORE_END}\r\n`);
  assert.equal(result.changed, true);
  assert.doesNotMatch(result.text, /(?<!\r)\n/);
});

test("replaces CRLF marker lines and preserves the surrounding text", () => {
  const before = "mine \t\r\n";
  const after = "\r\nfooter  ";
  const result = applyBlock(`${before}${CORE_BEGIN}\r\nold\r\n${CORE_END}${after}`, "first\nsecond");
  assert.equal(result.text, `${before}${CORE_BEGIN}\r\nfirst\r\nsecond\r\n${CORE_END}${after}`);
  assert.doesNotMatch(result.text, /(?<!\r)\n/);
});

test("ignores markers inside longer lines", () => {
  const text = `see ${CORE_BEGIN} here\nsee ${CORE_END} here\n`;
  assert.equal(applyBlock(text, "body").text,
    `${text}\n${CORE_BEGIN}\nbody\n${CORE_END}\n`);
});

test("accepts horizontal whitespace around whole-line markers", () => {
  const result = applyBlock(`mine\n \t${CORE_BEGIN}\t \nold\n\t${CORE_END} \t\nfooter`, "body");
  assert.equal(result.text, `mine\n${CORE_BEGIN}\nbody\n${CORE_END}\nfooter`);
});

test("keeps an absent final newline after an existing end marker", () => {
  assert.equal(applyBlock(`${CORE_BEGIN}\nold\n${CORE_END}`, "body").text,
    `${CORE_BEGIN}\nbody\n${CORE_END}`);
});

test("normalizes body line endings and trims only trailing whitespace", () => {
  assert.equal(applyBlock("", "  first  \r\nsecond\rthird  \n\t").text,
    `${CORE_BEGIN}\n  first  \nsecond\nthird\n${CORE_END}\n`);
});

for (const [name, text, begins, ends] of [
  ["a begin without an end", `${CORE_BEGIN}\nbody\n`, 1, 0],
  ["an end without a begin", `${CORE_END}\n`, 0, 1],
  ["two begins", `${CORE_BEGIN}\n${CORE_BEGIN}\n${CORE_END}\n`, 2, 1],
  ["two ends", `${CORE_BEGIN}\n${CORE_END}\n${CORE_END}\n`, 1, 2],
  ["an end above its begin", `${CORE_END}\n${CORE_BEGIN}\n`, 1, 1],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => applyBlock(text, "body"), {
      message: `CLAUDE.md has ${begins} begin and ${ends} end markers; fix them by hand`,
    });
  });
}
