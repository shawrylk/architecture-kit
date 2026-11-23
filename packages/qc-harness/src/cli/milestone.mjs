// Milestone publication state belongs to the shared Git directory, never the review ledger.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { git, identityEmail, lines, mergeStep, runShell, tryGit } from "./integrate.mjs";
import { commonDirOf, decidingVerdictFor, ledgerFileOf, readLedger } from "./ledger.mjs";
import { runGh } from "./gh-run.mjs";
import { postBody, redactOutput } from "./output-redaction.mjs";
import { pauseRefusal } from "./pause.mjs";

export const MILESTONE_PATTERN = /^milestone\/\d{4}-\d{2}-\d{2}-[1-9]\d*$/;
export const USAGE = `qc milestone [--dry-run] [--drop <branch>]
  Fetch origin and merge approved pushed issue branches into milestone/<YYYY-MM-DD>-<n>.
  Publish once and open one ready pull request. Conflicting branches are left out.
  --dry-run lists candidates without changing refs, files, or GitHub.
  --drop replays pinned members without the named branch, updating the same pull request.
  A failed publication resumes from shared Git state; an operator pause returns exit 5.`;

const kindsFor = (config) => ["codex", config.swarm?.review?.merge ?? "branch"];
const stateDir = (root) => path.join(commonDirOf(root), "qc", "milestones");
const stateFile = (root, name) => path.join(stateDir(root), `${name.slice("milestone/".length)}.json`);
function save(root, state) {
  const file = stateFile(root, state.name);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n");
  renameSync(temp, file);
}
function states(root) {
  if (!existsSync(stateDir(root))) return [];
  return readdirSync(stateDir(root)).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(stateDir(root), f), "utf8")));
}
function claim(root) {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "lock");
  if (existsSync(file)) {
    const holder = JSON.parse(readFileSync(file, "utf8"));
    if (!Number.isInteger(holder.pid) || holder.pid <= 0) throw new Error("invalid milestone lock; inspect shared Git state");
    try { process.kill(holder.pid, 0); throw new Error("another milestone is running"); }
    catch (error) {
      if (error.code !== "ESRCH") throw error;
      rmSync(file);
    }
  }
  const fd = openSync(file, "wx");
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { closeSync(fd); }
  return () => rmSync(file);
}
function fetch(root, dryRun = false) {
  // Dry runs read the advertised refs without updating FETCH_HEAD or any tracking refs.
  if (dryRun) return git(root, ["ls-remote", "--heads", "origin"]);
  git(root, ["fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  return git(root, ["for-each-ref", "--format=%(objectname)%09%(refname:strip=3)", "refs/remotes/origin/"]);
}

/** Collect only remote heads, after a successful fetch, whose deciding review is approved. */
export function collectFinished(config, { dryRun = false } = {}) {
  return collectFrom(config, fetch(config.root, dryRun), dryRun);
}
function collectFrom(config, text, dryRun = false) {
  const root = config.root;
  const refs = lines(text).map((line) => {
    const [sha, ref] = line.split("\t");
    return { sha, branch: dryRun ? ref.replace(/^refs\/heads\//, "") : ref };
  });
  const main = refs.find((r) => r.branch === "main")?.sha;
  if (!main) throw new Error("origin/main is missing");
  if (!tryGit(root, ["cat-file", "-e", `${main}^{commit}`]).ok) throw new Error("origin/main is not available locally; fetch before a dry run");
  const records = readLedger(ledgerFileOf(root));
  const pattern = new RegExp(config.branches?.pattern ?? "^[a-z]+/[0-9]+-");
  return refs.filter(({ branch, sha }) => {
    if (branch.startsWith("milestone/") || !pattern.test(branch) || !/^[a-z]+\/[1-9]\d*-/.test(branch)) return false;
    // A dry run may see an object not fetched yet. Fail closed instead of using a stale head.
    if (!tryGit(root, ["cat-file", "-e", `${sha}^{commit}`]).ok) return false;
    return !tryGit(root, ["merge-base", "--is-ancestor", sha, main]).ok
      && decidingVerdictFor(records, sha, kindsFor(config))?.verdict === "APPROVED";
  }).map(({ branch, sha }) => ({ branch, sha, issue: /^[a-z]+\/(\d+)-/.exec(branch)[1] }));
}

function nextName(root, now) {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const refs = git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/origin/"]);
  const names = new Set(lines(refs).map((r) => r.replace(/^refs\/(?:heads\/|remotes\/origin\/)/, "")));
  for (const state of states(root)) names.add(state.name);
  let n = 1;
  while (names.has(`milestone/${date}-${n}`)) n++;
  return `milestone/${date}-${n}`;
}
function settle(config, members, run, say) {
  const command = config.generated?.command;
  if (!command) return;
  if (run(command, config.root) !== 0) throw new Error(`${command} failed; recover the saved milestone before retrying`);
  if (git(config.root, ["status", "--porcelain"]).trim()) {
    git(config.root, ["add", "-A"]);
    git(config.root, ["commit", "-q", "-m", "chore: regenerate the generated files", "-m", members.map((m) => `Refs #${m.issue}`).join("\n")]);
    say(`commit the output of ${command}`);
  }
}

/** Merge pinned members in order; abort only a conflicting attempt and continue. */
export function buildMilestone(config, state, { say = console.log, run = runShell } = {}) {
  const root = config.root;
  const email = identityEmail(root, "author");
  identityEmail(root, "committer");
  const included = [];
  const mergedHeads = new Set(lines(git(root, ["log", "--first-parent", "--format=%P", "HEAD", "--not", state.base])).map((parents) => parents.split(" ")[1]));
  for (const member of state.members) {
    const result = mergeStep(config, member.sha, { base: state.base, email, say: () => {} });
    if (result.conflict) {
      git(root, ["merge", "--abort"]);
      say(`Left out: ${member.branch}: ${result.conflict.join(", ")}`);
    } else if (!result.skipped || mergedHeads.has(member.sha)) {
      included.push(member);
      if (!result.skipped) say(`merge  ${member.branch}`);
    }
  }
  if (included.length) settle(config, included, run, say);
  return included;
}

function bodyOf(state, config) {
  return postBody([...new Set(state.members.map((m) => `Refs #${m.issue}`))].join("\n"), config);
}

/** Publish once; retries after a GitHub failure reuse the published head and PR. */
export function publishMilestone(config, state, { say = console.log, gh = runGh } = {}) {
  const root = config.root;
  const head = state.head;
  const remote = tryGit(root, ["rev-parse", "--verify", `refs/remotes/origin/${state.name}`]).out.trim();
  if (remote && remote !== head) throw new Error(`published milestone ${state.name} moved; saved state retained`);
  if (!remote) git(root, ["push", "origin", `${head}:refs/heads/${state.name}`]);
  git(root, ["branch", "--set-upstream-to", `origin/${state.name}`, state.name]);
  state.publishedSha = head;
  state.phase = "published";
  save(root, state);
  if (gh(["pr", "view", state.name, "--json", "number"], { cwd: root }) === null) {
    const pr = gh(["pr", "create", "--head", state.name, "--base", state.baseBranch,
      "--title", redactOutput(`feat: milestone ${state.name.slice(10)}`), "--body", bodyOf(state, config)], { cwd: root });
    if (pr === null) throw new Error("gh pr create failed; run qc milestone again to resume");
    say(`pr     ${pr.trim()}`);
  }
  state.phase = "done";
  save(root, state);
}

/** Rebuild on a temporary local branch, then replace only the exact published remote head. */
export function dropMilestone(config, state, target, { say = console.log, run = runShell, gh = runGh } = {}) {
  const root = config.root;
  if (!state.members.some((m) => m.branch === target)) throw new Error(`${target} is not a member of ${state.name}`);
  const remote = git(root, ["rev-parse", `refs/remotes/origin/${state.name}`]).trim();
  if (!state.publishedSha || remote !== state.publishedSha) throw new Error("published milestone moved; refusing drop, saved state retained");
  const local = git(root, ["rev-parse", `refs/heads/${state.name}`]).trim();
  if (local !== state.publishedSha) throw new Error("local milestone moved; refusing drop, saved state retained");
  const start = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  const replay = `qc-milestone-replay-${process.pid}-${Date.now()}`;
  const next = { ...state, members: state.members.filter((m) => m.branch !== target), phase: "replaying" };
  git(root, ["switch", "-q", "-c", replay, state.base]);
  try {
    const members = buildMilestone(config, next, { say, run });
    if (members.length !== next.members.length) throw new Error("drop replay conflicted; original publication retained");
    next.head = git(root, ["rev-parse", "HEAD"]).trim();
    state.pendingDrop = { target, head: next.head, replay };
    save(root, state);
    git(root, ["push", `--force-with-lease=refs/heads/${state.name}:${state.publishedSha}`, "origin", `${next.head}:refs/heads/${state.name}`]);
    next.publishedSha = next.head;
    next.phase = "drop-published";
    delete next.pendingDrop;
    save(root, next);
    git(root, ["branch", "-f", state.name, next.head]);
    git(root, ["switch", "-q", state.name]);
    git(root, ["branch", "-D", replay]);
    if (gh(["pr", "edit", state.name, "--body", bodyOf(next, config)], { cwd: root }) === null) throw new Error("gh pr edit failed; run qc milestone to resume");
    next.phase = "done";
    save(root, next);
    return 0;
  } catch (error) {
    if (tryGit(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) git(root, ["merge", "--abort"]);
    if (!git(root, ["status", "--porcelain"]).trim()) git(root, ["switch", "-q", start]);
    throw error;
  }
}

export async function runMilestone(config, argv, { say = console.log, run = runShell, gh = runGh, now = new Date() } = {}) {
  let options;
  try {
    const parsed = parseArgs({ args: argv, options: { "dry-run": { type: "boolean" }, drop: { type: "string" } }, strict: true });
    options = parsed.values;
    if (options.drop && options["dry-run"]) throw new Error("--drop and --dry-run cannot be combined");
  } catch (error) {
    console.error(`qc milestone: ${error.message}\n${USAGE}`);
    return 2;
  }
  const root = config.root;
  let release;
  try {
    const refusal = pauseRefusal(root);
    if (refusal) { say(`qc milestone: ${refusal}`); return 5; }
    if (git(root, ["--no-optional-locks", "status", "--porcelain"]).trim()) throw new Error("the working tree has changes: commit or stash them first");
    if (tryGit(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) throw new Error("a merge is in progress");
    if (options["dry-run"]) {
      const members = collectFinished(config, { dryRun: true });
      for (const member of members) say(`${member.branch} ${member.sha}`);
      if (!members.length) say("nothing to merge");
      return 0;
    }
    if (config.integrate?.push === false) throw new Error("milestone publication requires integrate.push");
    release = claim(root);
    const fetched = fetch(root);
    const current = git(root, ["branch", "--show-current"]).trim();
    const saved = states(root);
    const io = { say, run, gh };
    if (options.drop) {
      let state = saved.find((s) => s.name === current);
      if (!state) {
        const open = gh(["pr", "list", "--state", "open", "--json", "headRefName"], { cwd: root });
        if (open === null) throw new Error("cannot read open milestones");
        const names = new Set(JSON.parse(open).map((pr) => pr.headRefName));
        const candidates = saved.filter((s) => names.has(s.name) && s.members.some((m) => m.branch === options.drop));
        if (candidates.length !== 1) throw new Error("drop needs a current milestone or one uniquely matching open milestone");
        state = candidates[0];
      }
      return dropMilestone(config, state, options.drop, io);
    }
    const unfinished = saved.filter((s) => s.phase !== "done");
    const selected = unfinished.find((s) => s.name === current);
    const pending = selected ? [selected] : unfinished;
    if (pending.length > 1) throw new Error("multiple unfinished milestones; switch to the one to recover");
    if (pending.length === 1) {
      const state = pending[0];
      if (state.pendingDrop) throw new Error(`retry --drop ${state.pendingDrop.target}; saved replay ${state.pendingDrop.replay}`);
      if (state.phase === "drop-published") {
        if (gh(["pr", "edit", state.name, "--body", bodyOf(state, config)], { cwd: root }) === null) throw new Error("gh pr edit failed");
        state.phase = "done"; save(root, state);
      } else if (state.head) publishMilestone(config, state, io);
      else {
        git(root, ["switch", "-q", state.name]);
        const history = lines(git(root, ["log", "--first-parent", "--format=%P", "HEAD", "--not", state.base]));
        if (history.some((parents) => parents.split(" ").length !== 2 || !state.members.some((m) => m.sha === parents.split(" ")[1]))) {
          throw new Error(`unfinished build on ${state.name} has unexpected commits; inspect saved state`);
        }
        state.members = buildMilestone(config, state, io);
        if (!state.members.length) { state.phase = "done"; save(root, state); say("nothing to merge"); return 0; }
        state.head = git(root, ["rev-parse", "HEAD"]).trim();
        state.phase = "built"; save(root, state);
        publishMilestone(config, state, io);
      }
      return 0;
    }
    const members = collectFrom(config, fetched);
    if (!members.length) { say("nothing to merge"); return 0; }
    const baseRef = config.worktree?.base ?? "origin/main";
    const baseBranch = baseRef.replace(/^refs\/(?:heads\/|remotes\/)/, "").replace(/^origin\//, "");
    if (!tryGit(root, ["check-ref-format", "--branch", baseBranch]).ok) throw new Error("worktree.base must name a branch");
    const state = { name: nextName(root, now), base: git(root, ["rev-parse", baseRef]).trim(), baseBranch, members, phase: "building" };
    git(root, ["switch", "-q", "-c", state.name, state.base]);
    save(root, state);
    state.members = buildMilestone(config, state, io);
    if (!state.members.length) {
      git(root, ["switch", "-q", current]);
      git(root, ["branch", "-D", state.name]);
      state.phase = "done"; save(root, state);
      say("nothing to merge"); return 0;
    }
    state.head = git(root, ["rev-parse", "HEAD"]).trim();
    state.phase = "built";
    save(root, state);
    publishMilestone(config, state, io);
    return 0;
  } catch (error) {
    console.error(`qc milestone: ${redactOutput(error.message)}`);
    return 1;
  } finally {
    release?.();
  }
}
