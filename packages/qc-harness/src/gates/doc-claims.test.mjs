import test from "node:test";
import assert from "node:assert/strict";
import { checkDocClaims, lineCount, parseDocClaims } from "./doc-claims.mjs";

const doc = "# State\n\n```state-claim\nfile: src/big.ts\nlines: 3\n```\n\n```state-claim\r\nfile: src/gone.ts\r\nlines: 9\r\n```\n";

test("each fenced block yields its file and line count, and a block missing one is skipped", () => {
  assert.deepEqual(parseDocClaims(doc), [{ file: "src/big.ts", lines: 3 }, { file: "src/gone.ts", lines: 9 }]);
  assert.deepEqual(parseDocClaims("```state-claim\nfile: a.ts\n```\n"), []);
});

test("lines are counted the way wc -l counts them, for LF and CRLF alike", () => {
  assert.equal(lineCount("a\nb\nc\n"), 3);
  assert.equal(lineCount("a\r\nb\r\nc\r\n"), 3);
  assert.equal(lineCount("a\nb\nc"), 3);
});

test("a claim that is still true passes", () => {
  const found = checkDocClaims("STATE.md", [{ file: "src/big.ts", lines: 3 }], new Map([["src/big.ts", "1\n2\n3\n"]]));
  assert.deepEqual(found, []);
});

test("a claim whose count changed, or whose file is gone, fails", () => {
  const found = checkDocClaims(
    "STATE.md",
    parseDocClaims(doc),
    new Map([["src/big.ts", "1\n2\n3\n4\n"], ["src/gone.ts", null]]),
  );
  assert.deepEqual(found.map((problem) => problem.rule), ["stale-doc-claim", "stale-doc-claim"]);
  assert.equal(found[0].path, "src/big.ts");
  assert.equal(found[0].detail, "STATE.md claims 3 lines; the file now has 4");
  assert.equal(found[1].detail, "STATE.md claims 9 lines; the file no longer exists");
});
