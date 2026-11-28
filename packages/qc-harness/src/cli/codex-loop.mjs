import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { runCodexImplement } from "./codex-implement.mjs";

const execute = promisify(execFile);
const runGit = (root, ...args) => execute("git", args, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
const USAGE = "usage: qc codex-loop --dir <run dir> --brief <name> [--rounds <n>] [--from-review <report>] [--skip-implement] [--base <ref>]";
function parse(argv) {
  const result = { rounds: 4, base: "origin/main" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--skip-implement") { result.skip = true; continue; }
    const key = { "--dir": "dir", "--brief": "brief", "--rounds": "rounds", "--from-review": "fromReview", "--base": "base" }[flag];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(USAGE);
    result[key] = argv[++i];
  }
  result.rounds = Number(result.rounds);
  if (!result.dir || !result.brief || path.basename(result.brief) !== result.brief || !Number.isInteger(result.rounds) || result.rounds < 1 || result.rounds > 6 || !/^[A-Za-z0-9._/-]+$/.test(result.base) || result.base.startsWith("-")) throw new Error(USAGE);
  result.dir = path.resolve(result.dir);
  return result;
}
const read = file => readFileSync(file, "utf8");
const field = (text, name) => new RegExp(`^${name}: \x60([^\x60]+)\x60`, "m").exec(text)?.[1];
function setField(text, name, value) {
  const pattern = new RegExp(`^${name}: .*`, "m"), line = `${name}: \`${value}\``;
  return pattern.test(text) ? text.replace(pattern, () => line) : text.replace(/^## Task/m, () => `${line}\n## Task`);
}
function fixBrief(source, dir, name, proof) {
  let text = setField(setField(source, "Report", path.join(dir, `${name}-report.md`)), "Progress", path.join(dir, `${name}-progress.md`));
  text = setField(text.replace(/^Proof: .*\r?\n/gm, ""), "Proof", proof);
  const start = text.indexOf("## Task"), next = text.indexOf("\n## ", start + 1);
  if (start < 0) throw new Error("brief needs ## Task");
  return text.slice(0, start) + "## Task\n\n1. Fix each finding in the review report named on the Proof line. Keep every product decision above.\n- Write each regression test first.\n- A finding that needs a product decision the brief does not give: write it under Questions in the report and fix the rest.\n2. Keep this run under 400 changed lines.\n\n" + (next < 0 ? "" : text.slice(next + 1));
}
async function reviewBrief(source, { dir, name, proof, base, worktree, git }) {
  const head = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  const issue = /^Issue: `?#?(\d+)`?/m.exec(source)?.[1];
  if (!issue || !/^[a-f0-9]{40}$/i.test(head)) throw new Error("review needs an issue and a commit head");
  let text = source.replace(/^# Brief: /m, "# Brief: review ");
  text = setField(setField(text, "Report", path.join(dir, `${name}-report.md`)), "Progress", path.join(dir, `${name}-progress.md`));
  text = text.replace(/^Verify: .*$/m, "Verify: none").replace(/^Proof: .*\r?\n/gm, "");
  text = setField(text.replace(/^Approved: .*\r?\n/gm, ""), "Proof", proof);
  const start = text.indexOf("## Task");
  if (start < 0) throw new Error("brief needs ## Task");
  text = text.slice(0, start) + `## Task\n\n1. Review the diff \`${base}...${head}\` against issue #${issue} and the decisions above.\n2. Check correctness, security, tenant and record safety, tests that prove each decision, and removed or weakened assertions.\n3. Write each finding with file, line, severity and a concrete failure. Write \`FINDINGS: <n>\` on its own line, then \`VERDICT: APPROVED\` or \`VERDICT: CHANGES_REQUIRED\`, as the report's last block.\n\n## Run shape\n\n1. Edit no file except the report and the progress file. Make no commit and no push.\n2. Read at most 15 files. Use narrow reads and searches.\n3. Never stop to ask: write the question in the report and continue.\n\n## Commit\n\nNone. A review makes no commit and no push.\n\n## Exit criteria\n\n- The report ends with the verdict block.\n- Write the runner's marker as the last line, alone, only when the exit criteria hold.\n`;
  const scope = /^Paths: (.+)$/m.exec(source)?.[1];
  if (scope) {
    const paths = [...scope.matchAll(/`([^`]+)`/g)].map(match => match[1]);
    // Git uses NUL separators so file names with spaces stay intact.
    let files;
    try { files = (await git(worktree, "diff", "--name-only", "-z", `${base}...HEAD`)).stdout.split("\0").filter(Boolean); } catch { files = []; }
    const extra = files.filter(file => !paths.some(p => p === "." || p === "./" || file === p || file.startsWith(p.replace(/\/$/, "") + "/")));
    if (extra.length) text += `\nScope check: outside Paths (diff against ${base}): ${extra.map(file => `\`${file}\``).join(", ")}. The report must give each file a reason and the smallest change; check consumers of a shared part. Report a file without a sound reason as a P1 finding.\n`;
  }
  return text;
}

export async function runCodexLoop(argv, { implement = runCodexImplement, git = runGit, clock = Date.now, warn = console.error } = {}) {
  let options;
  try { options = parse(argv); } catch (error) { warn(error.message); return 2; }
  const { dir, brief, rounds, base, fromReview, skip } = options;
  const note = line => appendFileSync(path.join(dir, "loop.status"), `${line}\n`);
  try {
    mkdirSync(dir, { recursive: true });
    const source = read(path.join(dir, brief)), worktree = field(source, "Worktree");
    if (!worktree) throw new Error("brief needs Worktree");
    const stem = path.parse(brief).name, suffix = stem.split("implement").at(-1) || "";
    async function run(file, name, review = false) {
      for (const ending of ["progress.md", "report.md"]) {
        const stale = path.join(dir, `${name}-${ending}`);
        if (existsSync(stale)) renameSync(stale, path.join(dir, `old-${clock()}-${name}-${ending}`));
      }
      const args = ["--brief", path.join(dir, file), "--worktree", worktree, "--progress", path.join(dir, `${name}-progress.md`), "--log", path.join(dir, `${name}-codex.log`), ...(review ? ["--review", "--report", path.join(dir, `${name}-report.md`)] : ["--role", "implement", "--effort", "high"])];
      const wrapper = path.join(dir, `${name}.wrapper`);
      writeFileSync(wrapper, "");
      const output = line => appendFileSync(wrapper, `${line}\n`);
      return implement(args, { out: output, warn: output, say: output });
    }
    function stop(code, name) {
      if (code === 2) { note(`STOP LIMIT ${name}`); return 2; }
      if (![0, 4, 7].includes(code)) { note(`STOP ${name} exit ${code}`); return 1; }
      return null;
    }
    let current = brief;
    if (!skip && !fromReview) {
      const code = await run(brief, stem); note(`${stem} exit ${code}`);
      const stopped = stop(code, stem); if (stopped !== null) return stopped;
    }
    if (fromReview) {
      const name = `loop-fix${suffix}-0`; current = `${name}.md`;
      writeFileSync(path.join(dir, current), fixBrief(source, dir, name, path.resolve(fromReview)));
      const code = await run(current, name); note(`${name} exit ${code}`);
      const stopped = stop(code, name); if (stopped !== null) return stopped;
    }
    for (let n = 1; n <= rounds; n++) {
      const name = `loop-review${suffix}-${n}`, proof = path.join(dir, `${path.parse(current).name}-report.md`);
      writeFileSync(path.join(dir, `${name}.md`), await reviewBrief(read(path.join(dir, current)), { dir, name, proof, base, worktree, git }));
      const code = await run(`${name}.md`, name, true);
      const report = path.join(dir, `${name}-report.md`);
      const verdict = existsSync(report) ? [...read(report).matchAll(/^VERDICT:\s*(\S+)/gm)].at(-1)?.[1] : null;
      note(`${name} exit ${code} ${verdict ?? "None"}`);
      if (code === 2) { note(`STOP LIMIT ${name}`); return 2; }
      if (code !== 0) { note(`STOP ${name} exit ${code}`); return 1; }
      if (verdict === "APPROVED") { note("DONE APPROVED"); return 0; }
      if (verdict !== "CHANGES_REQUIRED") { note(`STOP ${name} has no verdict`); return 1; }
      const fix = `loop-fix${suffix}-${n}`; current = `${fix}.md`;
      writeFileSync(path.join(dir, current), fixBrief(source, dir, fix, report));
      const fixed = await run(current, fix); note(`${fix} exit ${fixed}`);
      const stopped = stop(fixed, fix); if (stopped !== null) return stopped;
    }
    note(`STOP ${rounds} rounds without approval`); return 1;
  } catch (error) { warn(error.message); note(`STOP ${error.message}`); return 1; }
}
