// A fragment that reads a PowerShell command the way shell-command.mjs reads a POSIX one, for the
// Bash edit guard. It shares that parser and its git vocabulary, and an unknown name counts as a write.

import { GIT_READS, commandWords, gitCall, segmentsOf } from "./shell-command.mjs";

const DIALECT = { escape: "`" };

/** Splits a PowerShell command line into segments, with the backtick as its escape. */
export const powershellSegments = (command) => segmentsOf(command, DIALECT);
const NULL_DEVICES = new Set(["$null", "/dev/null", "nul"]);

/** Approved verbs that only read, and the cmdlets and aliases that only read or print. */
const READ_VERBS = new Set([
  "get", "test", "select", "measure", "format", "compare", "find", "resolve", "convertto",
  "convertfrom", "sort", "group", "where", "join", "split",
]);
const READ_NAMES = new Set([
  "write-output", "write-host", "out-null", "out-string", "out-host", "ls", "dir", "gci", "cat",
  "gc", "type", "sls", "select", "where", "?", "sort", "measure", "pwd", "gl", "echo", "write",
  "gi", "gp", "gcm", "gm", "ft", "fl", "popd", "pop-location",
]);
const LOCATION_NAMES = new Set(["cd", "chdir", "sl", "set-location", "pushd", "push-location"]);
const PATH_PARAMETERS = new Set(["-path", "-literalpath"]);

/** @returns the directory a location change moves to, or null when the segment is none. */
function locationTarget(segment) {
  const [program, ...args] = commandWords(segment);
  if (!LOCATION_NAMES.has(program?.toLowerCase())) return null;
  for (let i = 0; i < args.length; i++) {
    if (PATH_PARAMETERS.has(args[i].toLowerCase())) return args[i + 1] ?? "~";
    if (!args[i].startsWith("-")) return args[i];
  }
  return "~";
}

function isReadOnly(segment) {
  if (segment.redirects.some((file) => !NULL_DEVICES.has(file.toLowerCase()))) return false;
  // A script block can hold any command, so a segment that carries one is judged a write.
  if (segment.words.some((word) => word.includes("{"))) return false;
  if (locationTarget(segment) !== null) return true;
  const git = gitCall(segment);
  if (git) return GIT_READS.has(git.sub);
  const name = commandWords(segment)[0]?.toLowerCase() ?? "";
  const [verb, noun] = name.split("-");
  return READ_NAMES.has(name) || (noun !== undefined && READ_VERBS.has(verb));
}

/** False only when every segment is known to read, so an unknown command counts as a write. */
export const mayWrite = (command) => !segmentsOf(command, DIALECT).every(isReadOnly);

/** Every directory the command names through a location change or `git -C`, in order, as written. */
export function checkoutDirs(command) {
  const dirs = [];
  for (const segment of segmentsOf(command, DIALECT)) {
    const target = locationTarget(segment);
    if (target !== null) dirs.push(target);
    dirs.push(...(gitCall(segment)?.dirs ?? []).filter(Boolean));
  }
  return dirs;
}
