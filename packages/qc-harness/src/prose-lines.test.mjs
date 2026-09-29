import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseAddedLines } from "./prose-lines.mjs";

const DIFF = `diff --git a/docs/a.md b/docs/a.md
index 111..222 100644
--- a/docs/a.md
+++ b/docs/a.md
@@ -2,0 +3,2 @@ Heading
+first added
+second added
@@ -10 +12 @@ more
-old
+replaced
@@ -20,2 +21,0 @@
-gone one
-gone two
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,2 @@
+a
++b starts with a plus
diff --git a/docs/dead.md b/docs/dead.md
deleted file mode 100644
--- a/docs/dead.md
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

test("the added-line parser maps hunks to line numbers", () => {
  assert.deepEqual(parseAddedLines(DIFF), [
    { path: "docs/a.md", line: 3, text: "first added" },
    { path: "docs/a.md", line: 4, text: "second added" },
    { path: "docs/a.md", line: 12, text: "replaced" },
    { path: "docs/new.md", line: 1, text: "a" },
    { path: "docs/new.md", line: 2, text: "+b starts with a plus" },
  ]);
});

test("a diff with CRLF line endings parses the same", () => {
  assert.deepEqual(parseAddedLines("+++ b/x.md\r\n@@ -0,0 +1 @@\r\n+hi\r\n"), [{ path: "x.md", line: 1, text: "hi" }]);
});

test("an empty diff has no added lines", () => {
  assert.deepEqual(parseAddedLines(""), []);
});

test("a path that git quotes is unquoted", () => {
  assert.deepEqual(parseAddedLines('+++ "b/docs/a b.md"\n@@ -0,0 +1 @@\n+hi\n'), [{ path: "docs/a b.md", line: 1, text: "hi" }]);
});

test("an added line that starts with two plus signs is a line, not a file header", () => {
  const diff = "+++ b/x.md\n@@ -0,0 +1,2 @@\n+++ not a header\n+next\n";
  assert.deepEqual(parseAddedLines(diff), [
    { path: "x.md", line: 1, text: "++ not a header" },
    { path: "x.md", line: 2, text: "next" },
  ]);
});
