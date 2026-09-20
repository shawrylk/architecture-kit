// `no-comment-paragraph`'s rule, for files ESLint cannot parse: Terraform, tfvars, HCL, shell.
// Same threshold (config.comments.maxLines), a raw `#`-line scan instead of an AST walk.

const BANNER = /^(?:[-=*_~#]{4,})$/;
const CODE_SHAPE = [
  /^(?:resource|module|variable|data|output|locals?|provider|terraform)\s+["\w]/,
  /^[\w.-]+\s*=\s*\S/,
  /^(?:if|for|case|while)\s/,
  /^[\w./-]+\(.*\)\s*$/,
];
const STATEMENT_END = /[;{}")\]]$/;

function looksLikeCode(line) {
  return CODE_SHAPE.some((shape) => shape.test(line)) && STATEMENT_END.test(line);
}

function runsOf(lines) {
  const runs = [];
  let current = null;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const isComment = trimmed.startsWith("#") && !trimmed.startsWith("#!");
    if (!isComment) {
      current = null;
      return;
    }
    if (current && index === current.lastLine + 1) {
      current.lines.push(index);
      current.lastLine = index;
    } else {
      current = { startLine: index, lastLine: index, lines: [index] };
      runs.push(current);
    }
  });
  return runs;
}

function proseOf(run, lines) {
  return run.lines
    .map((i) => lines[i].trim().replace(/^#\s?/, "").trim())
    .filter((line) => line !== "");
}

/**
 * @param {{path: string, contents: string}[]} files
 * @param {{maxLines?: number}} [options]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkCommentStyle(files, options = {}) {
  const maxLines = options.maxLines ?? 2;
  const problems = [];
  for (const { path, contents } of files) {
    const lines = contents.split("\n");
    for (const run of runsOf(lines)) {
      const prose = proseOf(run, lines);
      if (prose.length === 0) continue;
      const range = `${run.startLine + 1}-${run.lastLine + 1}`;
      if (prose.some((line) => BANNER.test(line))) {
        problems.push({ path, rule: "banner-comment", detail: `${range}: banner comment` });
        continue;
      }
      if (prose.some(looksLikeCode)) {
        problems.push({ path, rule: "commented-code", detail: `${range}: commented-out code` });
        continue;
      }
      if (prose.length > maxLines) {
        problems.push({
          path,
          rule: "comment-paragraph",
          detail: `${range}: ${prose.length} lines, max ${maxLines}`,
        });
      }
    }
  }
  return problems;
}
