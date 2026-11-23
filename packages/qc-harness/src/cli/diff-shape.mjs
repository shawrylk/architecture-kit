import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const normalize = (file) => file.replace(/\\/g, "/").replace(/^\.\//, "");
const splitNames = (text) => text.split("\0").filter(Boolean);

/** Fragment: matches owned files, folder boundaries and the brief's globs. */
function ownership(paths) {
  const patterns = paths.map(normalize).flatMap((file) => {
    const name = file.replace(/\/$/, "");
    return file.includes("*") ? [file] : [name, `${name}/**`];
  }).map((glob) => {
    // Each recursive directory segment can independently consume zero or more folders.
    const body = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\/|\*\*|\*/g, (token) => token === "**/" ? "(?:[^/]+/)*" : token === "**" ? ".*" : "[^/]*");
    return new RegExp(`^${body}$`, process.platform === "win32" ? "i" : "");
  });
  return (file) => patterns.some((pattern) => pattern.test(file));
}

/** Fragment: parses NUL-delimited numstat without Git's quoted-path ambiguity. */
function changedLines(text, totals) {
  for (const entry of splitNames(text)) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    const count = (Number(match[1]) || 0) + (Number(match[2]) || 0);
    totals.set(match[3], Math.max(totals.get(match[3]) ?? 0, count));
  }
}

/** Fragment: manifest failures identify the file, without printing its contents. */
function manifest(text, file) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    for (const key of ["dependencies", "devDependencies"]) {
      if (value[key] !== undefined && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) throw new Error();
    }
    return value;
  } catch {
    throw new Error(`${file}: invalid package manifest JSON`);
  }
}

/** Branch: new dependency keys (including aliases) need their exact names in Design. */
function dependencyProblems(file, original, versions, design) {
  const problems = new Set();
  const approved = new Set((design.match(/[@\w][@\w./-]*/g) ?? []).flatMap((name) => [name, name.replace(/\.+$/, "")]));
  for (const text of versions) {
    const current = manifest(text, file);
    for (const section of ["dependencies", "devDependencies"]) {
      for (const name of Object.keys(current[section] ?? {})) {
        if (!Object.hasOwn(original[section] ?? {}, name) && !approved.has(name)) problems.add(`${file}: added ${section} ${name} is absent from Design`);
      }
    }
  }
  return [...problems];
}

/** Branch: checks every changed path, manifest addition and added/deleted line against a frozen brief. */
export function checkDiffShape({ worktree, base, baseRef, paths, design = "", maxDiffLines = 400 }) {
  const git = (...args) => execFileSync("git", ["--literal-pathspecs", ...args], { cwd: worktree, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const empty = git("hash-object", "-w", "-t", "tree", "--stdin").trim();
  const contains = (ancestor, revision) => {
    try { git("merge-base", "--is-ancestor", ancestor, revision); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  const hasHead = git("rev-parse", "--revs-only", "HEAD").trim();
  const boundaries = new Map();
  const boundaryOf = (revision) => {
    let tip;
    if (base && baseRef && revision) {
      try { tip = git("merge-base", revision, baseRef).trim(); } catch { /* Missing or invalid base refs keep the frozen boundary. */ }
    }
    if (!tip) return { boundary: base || empty };
    if (boundaries.has(tip)) return boundaries.get(tip);
    let result = { boundary: base };
    if (!contains(tip, base)) {
      let merged;
      try { merged = git("merge-tree", "--write-tree", base, tip); }
      catch (error) { if (error.status !== 1) throw error; merged = error.stdout; }
      result = { boundary: merged.split("\n")[0].trim(), tip };
    }
    boundaries.set(tip, result);
    return result;
  };
  const { boundary, tip } = boundaryOf(hasHead ? "HEAD" : undefined);
  // Incoming commits belong to the base; retain the run's commits on either side of the merge.
  const commits = hasHead ? git("rev-list", "--reverse", ...(base ? [`${base}..HEAD`] : ["HEAD"]), ...(tip ? [`^${tip}`] : [])).trim().split("\n").filter(Boolean) : [];
  const changed = new Set();
  const totals = new Map();
  const versions = new Map();
  const collect = (args, revision) => {
    const files = splitNames(git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", ...args, "--"));
    changedLines(git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", ...args, "--"), totals);
    for (const file of files) {
      changed.add(file);
      if (path.posix.basename(file) !== "package.json" || revision === undefined) continue;
      const exists = splitNames(git("ls-tree", "-r", "--name-only", "-z", revision, "--", file)).includes(file);
      if (exists) {
        const list = versions.get(file) ?? [];
        list.push(git("show", `${revision}:${file}`)); versions.set(file, list);
      }
    }
  };
  for (const commit of commits) collect([boundaryOf(commit).boundary, commit], commit);
  collect(["--cached", boundary]);
  collect([boundary]);
  const staged = splitNames(git("diff", "--cached", "--no-renames", "--name-only", "-z", boundary, "--"));
  for (const file of staged.filter((name) => path.posix.basename(name) === "package.json")) {
    const entries = splitNames(git("ls-files", "-z", "--", file));
    if (entries.includes(file)) {
      const list = versions.get(file) ?? []; list.push(git("show", `:${file}`)); versions.set(file, list);
    }
  }
  const untracked = splitNames(git("ls-files", "--others", "--exclude-standard", "-z"));
  for (const file of untracked) {
    changed.add(file);
    const target = path.join(worktree, file);
    const stat = lstatSync(target);
    const text = stat.isSymbolicLink() ? "link\n" : readFileSync(target, "utf8");
    const lines = text.includes("\0") ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    totals.set(file, (totals.get(file) ?? 0) + lines);
  }
  const owns = ownership(Array.isArray(paths) ? paths : [paths]);
  const problems = [...changed].filter((file) => !owns(normalize(file))).map((file) => `${file}: outside Paths`);
  for (const file of [...changed].filter((name) => path.posix.basename(name) === "package.json")) {
    try {
      const original = {};
      // A merge tree can contain conflict markers; read dependency keys from its parents instead.
      for (const revision of [base || empty, ...(tip ? [tip] : [])]) {
        const exists = splitNames(git("ls-tree", "-r", "--name-only", "-z", revision, "--", file)).includes(file);
        if (!exists) continue;
        const value = manifest(git("show", `${revision}:${file}`), file);
        for (const section of ["dependencies", "devDependencies"]) {
          original[section] = { ...original[section], ...value[section] };
        }
      }
      const list = versions.get(file) ?? [];
      try {
        const target = path.join(worktree, file);
        if (lstatSync(target).isSymbolicLink()) throw new Error(`${file}: package manifest must be a regular file`);
        list.push(readFileSync(target, "utf8"));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      problems.push(...dependencyProblems(file, original, list, design));
    } catch (error) { problems.push(error.message); }
  }
  const lines = [...totals.values()].reduce((sum, count) => sum + count, 0);
  if (lines > maxDiffLines) problems.push(`${lines} changed lines exceeds codex.maxDiffLines ${maxDiffLines}; split the issue`);
  return { problems: [...new Set(problems)] };
}
