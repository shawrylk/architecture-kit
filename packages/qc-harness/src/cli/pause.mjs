import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

function pauseFile(root) {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
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
  return reason === null ? null : `Paused: ${reason}. Run qc resume to continue.`;
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
    say(`paused: ${reason}. Run qc resume to continue.`);
    return 0;
  } catch (error) {
    say(`qc pause: ${error.message}`);
    return 1;
  }
}

/** Trigger: clear the operator pause. */
export function runResume(root, argv, { say = console.log } = {}) {
  if (argv.length !== 0) {
    say("usage: qc resume");
    return 2;
  }
  try {
    rmSync(pauseFile(root), { force: true });
    say("running");
    return 0;
  } catch (error) {
    say(`qc resume: ${error.message}`);
    return 1;
  }
}
