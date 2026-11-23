import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnCommand } from "./spawn-command.mjs";

const cleanup = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
const git = (worktree, ...args) => execFileSync("git", ["--literal-pathspecs", ...args], {
  cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
});
const names = (text) => text.split("\0").filter(Boolean);
const normalize = (file) => file.replace(/\\/g, "/");
const testFile = (file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(__tests__|tests?|spec)\/.*\.[cm]?[jt]sx?$/.test(file);
const registration = /^\s*(test|it)(\.only|\.skip)?\(/;

/** Rejects unsafe lock paths and symlinks before reading or copying files. */
function safeFile(worktree, file) {
  const name = normalize(file);
  if (!name || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error(`unsafe locked test path: ${file}`);
  const target = path.resolve(worktree, name);
  const relative = path.relative(realpathSync(worktree), realpathSync(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !lstatSync(target).isFile()) throw new Error(`unsafe locked test path: ${file}`);
  return target;
}

/** The common directory shares locks between the main checkout and linked worktrees. */
export function lockedTestsFile(worktree) {
  const common = git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  const branch = git(worktree, "symbolic-ref", "--quiet", "--short", "HEAD").trim();
  return path.join(common, "qc", "locked-tests", `${encodeURIComponent(branch)}.json`);
}

export function readLockedTests(worktree) {
  const file = lockedTestsFile(worktree);
  if (!existsSync(file)) return null;
  const locked = JSON.parse(readFileSync(file, "utf8"));
  if (!locked || typeof locked !== "object" || Array.isArray(locked) || Object.entries(locked).some(([name, hash]) => !name || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new Error("invalid locked-tests file");
  return locked;
}

const hashFile = (worktree, file) => createHash("sha256").update(readFileSync(safeFile(worktree, file))).digest("hex");

/** Atomically publishes the exact path-to-hash map after a successful tests run. */
export function lockTests(worktree, files) {
  const locked = Object.fromEntries([...new Set(files.map(normalize))].sort().map((file) => [file, hashFile(worktree, file)]));
  const destination = lockedTestsFile(worktree);
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(locked, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, destination);
  } finally { rmSync(temporary, cleanup); }
  return locked;
}

/** A frozen map also catches deletion and rename, even if the child rewrites its lock. */
export function checkLockedTests(worktree, locked = readLockedTests(worktree)) {
  const problems = [];
  for (const [file, hash] of Object.entries(locked ?? {})) {
    try {
      if (hashFile(worktree, file) !== hash) problems.push(`locked test changed: ${file}`);
    } catch { problems.push(`locked test missing or unsafe: ${file}`); }
  }
  return { problems };
}

/** Counts only added registration lines, using the final tree rather than summing Git layers. */
export function addedTestCases(worktree, base) {
  const boundary = base || git(worktree, "hash-object", "-w", "-t", "tree", "--stdin").trim();
  const tracked = names(git(worktree, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", boundary, "--"));
  const untracked = names(git(worktree, "ls-files", "--others", "--exclude-standard", "-z"));
  const cases = [];
  for (const file of new Set([...tracked, ...untracked])) {
    if (!testFile(file) || !existsSync(path.join(worktree, file))) continue;
    const text = untracked.includes(file) ? readFileSync(safeFile(worktree, file), "utf8") : git(worktree, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", boundary, "--", file).split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
    for (const line of text.split(/\r?\n/)) {
      if (!registration.test(line)) continue;
      const name = /\(\s*(['"`])(.*?)\1/.exec(line)?.[2] ?? line.trim();
      cases.push({ path: normalize(file), name });
    }
  }
  return cases;
}

/** Runs literal argv through the shared Windows shim resolver. */
export function runTestCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    let child;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    try { child = spawnCommand(command[0], command.slice(1), { cwd, env, stdio: "inherit", windowsHide: true }); }
    catch (error) { reject(error); return; }
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
}

/** Each new test file must be red on the frozen merge base; every nonzero status is red. */
export async function verifyBaseTests(worktree, base, cases, command = ["node", "--test"]) {
  const problems = [];
  if (!cases.length) return { problems };
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-base-tests-"));
  const checkout = path.join(root, "base");
  try {
    git(worktree, "worktree", "add", "--detach", checkout, base);
    for (const file of new Set(cases.map((entry) => entry.path))) {
      const source = safeFile(worktree, file);
      const destination = path.join(checkout, file);
      // Refuse a base-tree symlink in any destination parent.
      mkdirSync(path.dirname(destination), { recursive: true });
      const relative = path.relative(realpathSync(checkout), realpathSync(path.dirname(destination)));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || (existsSync(destination) && lstatSync(destination).isSymbolicLink())) throw new Error(`unsafe base test path: ${file}`);
      copyFileSync(source, destination);
      if (await runTestCommand([...command, file], checkout) === 0) {
        problems.push(`${file}: passes on the base: ${cases.filter((entry) => entry.path === file).map((entry) => entry.name).join(", ")}`);
      }
    }
    return { problems };
  } finally {
    try { git(worktree, "worktree", "remove", "--force", checkout); }
    finally { rmSync(root, cleanup); }
  }
}
