// A fragment that runs one command line in the shell, the way a Windows `.cmd` shim such as `pnpm` needs.
// The caller ignores Ctrl+C while the command runs, so it can clean up after the command exits.

import { spawn } from "node:child_process";

/** One shell command line from argv words; a word with a space or a quote is quoted. */
export function commandLine(words) {
  const args = words[0] === "--" ? words.slice(1) : words;
  return args.map((arg) => (/^$|[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)).join(" ");
}

/** Splits argv at its first `--`: the flags before it, and the command after it. */
export function splitAtDashes(argv) {
  const at = argv.indexOf("--");
  return at < 0 ? { flags: argv, command: [] } : { flags: argv.slice(0, at), command: argv.slice(at + 1) };
}

/** Runs `command` in the shell. @returns a promise of its exit code; a command ended by a signal returns 1 */
export function runInShell(command, env = process.env, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: "inherit", env, cwd, windowsHide: true });
    const ignore = () => {};
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", ignore);
    process.on("SIGTERM", stop);
    const done = () => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", stop);
    };
    child.on("error", (error) => {
      done();
      reject(error);
    });
    child.on("exit", (code) => {
      done();
      resolve(code ?? 1);
    });
  });
}
