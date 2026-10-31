import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commonDirOf } from "./ledger.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";

function holdFile(root, branch) {
  if (!branch || branch === "." || branch === ".." || /[\\\x00-\x1f]/.test(branch)) throw new Error("invalid branch for CI hold");
  const common = commonDirOf(checkoutRootOf(root) ?? root);
  if (!common) throw new Error("CI hold needs a Git checkout");
  return path.join(common, "qc", "holds", branch.replaceAll("/", "-"));
}

export function holdBranch(root, branch, reason) {
  const file = holdFile(root, branch);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${reason}\n`);
}

export function holdRefusal(root, branch) {
  let reason;
  try {
    reason = readFileSync(holdFile(root, branch), "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return `Operator: branch ${branch} is on hold: ${reason}. Wait for the operator to run \`qc resume --branch ${branch}\`.`;
}

function pauseFile(root) {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  }).trim();
  return path.join(common, "qc", "pause");
}

/** Fragment: read the operator pause shared by all worktrees. */
export function pauseState(root) {
  const file = pauseFile(root);
  try {
    return readFileSync(file, "utf8").trim() || "operator pause";
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Branch: refuse a command while the operator pause exists. */
export function pauseRefusal(root) {
  const reason = pauseState(root);
  return reason === null ? null : `An operator paused the kit: ${reason}. Wait for the operator to run \`qc resume\`.`;
}

/** Trigger: set or inspect the operator pause. */
export function runPause(root, argv, { say = console.log } = {}) {
  try {
    if (argv.length === 1 && argv[0] === "--status") {
      const reason = pauseState(root);
      say(reason === null ? "running" : `paused: ${reason}`);
      return 0;
    }
    if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== "--reason" || !argv[1].trim())) {
      say("usage: qc pause [--reason <text>] | qc pause --status");
      return 2;
    }
    const file = pauseFile(root);
    const reason = argv[1]?.trim() || "operator pause";
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${reason}\n`);
    say("The kit is paused. Run `qc resume` to lift the pause.");
    return 0;
  } catch (error) {
    say(`qc pause: ${error.message}`);
    return 1;
  }
}

/** Trigger: clear the operator pause. */
export function runResume(root, argv, { say = console.log } = {}) {
  if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== "--branch" || !argv[1])) {
    say("usage: qc resume [--branch <branch>]");
    return 2;
  }
  try {
    rmSync(argv.length ? holdFile(root, argv[1]) : pauseFile(root), { force: true });
    say("running");
    return 0;
  } catch (error) {
    say(`qc resume: ${error.message}`);
    return 1;
  }
}
