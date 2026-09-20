import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkCommentStyle } from "./comment-style.mjs";

test("a one-line comment passes", () => {
  const problems = checkCommentStyle([{ path: "a.tf", contents: "# why this exists\nresource {}" }]);
  assert.deepEqual(problems, []);
});

test("a comment run over maxLines fails and names the range", () => {
  const contents = "# line one\n# line two\n# line three\nresource {}";
  const problems = checkCommentStyle([{ path: "a.tf", contents }]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "comment-paragraph");
  assert.equal(problems[0].detail, "1-3: 3 lines, max 2");
});

test("maxLines is configurable", () => {
  const contents = "# line one\n# line two\n# line three\nresource {}";
  const problems = checkCommentStyle([{ path: "a.tf", contents }], { maxLines: 3 });
  assert.deepEqual(problems, []);
});

test("a banner comment fails regardless of length", () => {
  const problems = checkCommentStyle([{ path: "a.sh", contents: "# ----------\necho hi" }]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "banner-comment");
});

test("commented-out code fails regardless of length", () => {
  const problems = checkCommentStyle([{ path: "a.tf", contents: '# name = "value"\nresource {}' }]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "commented-code");
});

test("a shebang line breaks the run rather than joining it", () => {
  const contents = "#!/usr/bin/env bash\n# one\n# two\necho hi";
  const problems = checkCommentStyle([{ path: "a.sh", contents }]);
  assert.deepEqual(problems, []);
});

test("two runs separated by code are measured independently", () => {
  const contents = "# first run\nresource {}\n# second run\nmodule {}";
  const problems = checkCommentStyle([{ path: "a.tf", contents }]);
  assert.deepEqual(problems, []);
});
