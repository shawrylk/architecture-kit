// Repository summaries and the debt review watermark; the workflow ledger stays read-only.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoFiles } from "./repo-files.mjs";
import { commonDirOf } from "./ledger.mjs";
import { openFailures } from "./ci-failures.mjs";
import { runGhResult } from "./gh-run.mjs";

const line = (text) => String(text).replace(/\s+/g, " ").trim().slice(0, 100);
const commands = (root, options) => ({
  git: options.git ?? ((args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim()),
  gh: options.gh ?? ((args) => {
    const result = runGhResult(args, { cwd: root });
    if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || "gh failed");
    return result.stdout;
  }),
});
const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const lockfile = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|(?:yarn|bun)\.lockb?|[^/]+\.lock|go\.sum)$/;

async function textFiles(root) {
  const files = new Map();
  for (const file of await repoFiles(root)) {
    if (lockfile.test(file)) continue;
    try {
      const bytes = readFileSync(path.join(root, file));
      if (!bytes.includes(0)) files.set(file, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch { /* Missing files and binary encodings have no text ranking. */ }
  }
  return files;
}

function churn(git, files, ref) {
  const counts = new Map();
  for (const file of git(["log", "--since=90.days", "--format=", "--name-only", "-z", "--no-renames", ref, "--"]).split("\0")) {
    if (sourceFile.test(file) && files.has(file)) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export async function buildOverview(root, options = {}) {
  const { git, gh } = commands(root, options), files = await textFiles(root);
  const modules = [...(files.get("docs/architecture.md") ?? "").matchAll(/^#{2,3}\s+(.+)$/gm)].map((match) => match[1]);
  const largest = [...files].filter(([file]) => sourceFile.test(file)).map(([file, text]) => [file, text.trimEnd().split("\n").length])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const branch = git(["branch", "--show-current"]);
  let debt;
  try { debt = JSON.parse(gh(["issue", "list", "--state", "open", "--label", "debt", "--limit", "1000", "--json", "title"])).map((issue) => issue.title); }
  catch (error) { debt = [`unavailable: ${error.message}`]; }
  const sections = [
    ["Modules", modules.length ? modules : ["docs/architecture.md has no module headings"]],
    ["Largest", largest.map(([file, n]) => `${file}: ${n} lines`)],
    ["Churn", churn(git, files, "HEAD").map(([file, n]) => `${file}: ${n} touches`)],
    ["CI failures", openFailures(root, branch).map((r) => `${r.file ?? r.job ?? "CI"}: ${r.test} ${r.error ?? ""}`)],
    ["Debt", debt],
  ];
  return sections.flatMap(([title, items]) => [title, ...(items.length ? items : ["None"]).slice(0, 10).map((item) => `- ${line(item)}`.slice(0, 100))]).join("\n") + "\n";
}

function debtItems(report) {
  let fenced = false;
  const text = report.split(/\r?\n/).filter((row) => {
    if (/^\s*(```|~~~)/.test(row)) { fenced = !fenced; return false; }
    return !fenced;
  }).join("\n");
  const items = [];
  for (const section of text.split(/^## Debt\s*$/m).slice(1)) {
    const body = section.split(/^#{1,2}\s/m)[0].trim();
    if (body.startsWith("None")) continue;
    for (const match of body.matchAll(/^- (.+)((?:\n(?!- ).*)*)/gm)) {
      const title = match[1].split(".")[0].trim().slice(0, 80);
      if (title) items.push({ title, body: match[0].slice(2).trim() });
    }
  }
  return items;
}

function reviewFile(root) {
  const common = commonDirOf(root);
  if (!common) throw new Error("no git common directory");
  return path.join(common, "qc", "debt-review.json");
}

export async function fileDebt(root, report, options = {}) {
  const items = debtItems(readFileSync(path.resolve(root, report), "utf8"));
  const { git, gh } = commands(root, options), file = reviewFile(root);
  const main = git(["rev-parse", "--verify", "origin/main"]);
  const titles = new Set(JSON.parse(gh(["issue", "list", "--state", "open", "--limit", "1000", "--json", "title"])).map((issue) => issue.title));
  for (const item of items) {
    if (titles.has(item.title)) continue;
    gh(["issue", "create", "--label", "debt", "--title", item.title, "--body", item.body]);
    titles.add(item.title);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ main }) + "\n");
}

export async function debtDue(root, options = {}) {
  try {
    const { git } = commands(root, options);
    let main;
    try { ({ main } = JSON.parse(readFileSync(reviewFile(root), "utf8"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (main !== undefined) {
      if (!/^[a-f0-9]{40,64}$/.test(main)) throw new Error("invalid debt review SHA");
      git(["merge-base", "--is-ancestor", main, "origin/main"]);
    }
    const subjects = git(["log", "--first-parent", "--merges", "--format=%s", main ? `${main}..origin/main` : "origin/main", "--"]);
    const count = subjects.split("\n").filter((subject) => /(?: from [^\s/]+\/milestone\/\d{4}-\d{2}-\d{2}-\d+$|^Merge branch 'milestone\/\d{4}-\d{2}-\d{2}-\d+'$)/.test(subject)).length;
    if (count < 10) { (options.log ?? console.log)(`not due: ${count} of 10`); return 1; }
    const files = new Set(git(["ls-tree", "-r", "--name-only", "-z", "origin/main"]).split("\0"));
    const top = churn(git, files, "origin/main").find(([file]) => {
      const text = git(["show", `origin/main:${file}`]);
      return !text.includes("\0") && !text.includes("\ufffd");
    });
    if (!top) throw new Error("no source text files in the churn window");
    (options.log ?? console.log)(`due: ${line(path.posix.dirname(top[0]))}`);
    return 0;
  } catch (error) {
    (options.error ?? console.error)(`debt: ${line(error.message)}`);
    return 3;
  }
}
