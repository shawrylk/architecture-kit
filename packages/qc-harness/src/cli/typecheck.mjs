// `qc typecheck`: the repository's own `typecheck` script when it has one, else the installed tsc.
// tsc builds only a tsconfig with project references, because a build writes a .tsbuildinfo file
// and leaves the tree dirty. The hooks and CI call this one command, so they run the same check.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The command that typechecks `root`, or null when it has no typecheck script and no tsc. */
export function typecheckCommand(root) {
  const manifest = path.join(root, "package.json");
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
  } catch {}
  if (typeof scripts.typecheck === "string") {
    const manager = existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(path.join(root, "yarn.lock")) ? "yarn" : "npm";
    return { cmd: manager, args: ["run", "-s", "typecheck"], shell: true };
  }
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const tsconfig = path.join(root, "tsconfig.json");
  if (!existsSync(tsc) || !existsSync(tsconfig)) return null;
  const references = /"references"\s*:/.test(readFileSync(tsconfig, "utf8"));
  return { cmd: process.execPath, args: [tsc, ...(references ? ["-b"] : ["--noEmit", "-p", "."]), "--pretty", "false"], shell: false };
}

/** True when every error is TS2307, which a concurrent install produces while a module is missing for a moment. */
export function onlyMissingModules(output) {
  const errors = output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line));
  return errors.length > 0 && errors.every((line) => line.includes("error TS2307"));
}

/** @returns the exit code of the typecheck, or 0 when the repository has nothing to typecheck. */
export function runTypecheck(config) {
  const command = typecheckCommand(config.root);
  if (command === null) {
    console.log("typecheck skipped: no typecheck script and no tsc with a tsconfig.json");
    return 0;
  }
  const once = () => spawnSync(command.cmd, command.args, { cwd: config.root, encoding: "utf8", shell: command.shell, windowsHide: true, maxBuffer: 1 << 26 });
  let result = once();
  if (result.status !== 0 && onlyMissingModules(`${result.stdout}${result.stderr}`)) result = once();
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return result.status ?? 1;
}
