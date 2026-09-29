// A fragment: the lines a unified diff adds. `qc prose` judges only these, so a repository adopts the
// prose style without first rewriting every sentence it already has.

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** @returns the repository path a `+++` header names, or null for a deleted file. */
function pathOfHeader(header) {
  const target = header.slice(4).trim();
  if (target === "/dev/null") return null;
  const unquoted = target.startsWith('"') && target.endsWith('"') ? target.slice(1, -1) : target;
  return unquoted.replace(/^b\//, "");
}

/**
 * The hunk header counts the rows the hunk holds, so a body row that starts with `+++ ` is an added
 * line, never a file header.
 * @param {string} diff the output of `git diff -U0`
 * @returns {{path: string, line: number, text: string}[]} each added line, with its number in the new file
 */
export function parseAddedLines(diff) {
  const added = [];
  let path = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.split("\n")) {
    const row = raw.replace(/\r$/, "");
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (inHunk && row.startsWith("+")) {
      if (path !== null) added.push({ path, line, text: row.slice(1) });
      line += 1;
      newLeft -= 1;
    } else if (inHunk && row.startsWith("-")) {
      oldLeft -= 1;
    } else if (row.startsWith("diff --git ")) {
      path = null;
    } else if (row.startsWith("+++ ")) {
      path = pathOfHeader(row);
    } else {
      const hunk = HUNK.exec(row);
      if (hunk) {
        oldLeft = Number(hunk[1] ?? 1);
        line = Number(hunk[2]);
        newLeft = Number(hunk[3] ?? 1);
      }
    }
  }
  return added;
}
