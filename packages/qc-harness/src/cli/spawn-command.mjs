// A pipeline that resolves Windows executables and runs shims with literal arguments.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

const meta = /([()\][%!^"`<>&|;, *?])/g;
const escapeMeta = (value) => value.replace(meta, "^$1");

function quoteArgument(value) {
  const quoted = '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1") + '"';
  // Batch shims forward arguments through a second cmd.exe parse.
  return escapeMeta(escapeMeta(quoted));
}

function resolveCommand(command, cwd, env) {
  const get = (key) => env[Object.keys(env).find((name) => name.toUpperCase() === key)] ?? "";
  const extensions = get("PATHEXT").split(";").filter(Boolean);
  const suffixes = path.extname(command) ? [""] : (extensions.length ? extensions : [".COM", ".EXE", ".BAT", ".CMD"]);
  const directories = /[\\/]/.test(command) ? [cwd] : [cwd, ...get("PATH").split(";").map((entry) => entry.replace(/^"|"$/g, ""))];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(cwd, directory, command + suffix);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Missing candidates let the search continue through PATH.
      }
    }
  }
  return command;
}

export function spawnCommand(command, args = [], options = {}) {
  const settings = { ...options, shell: false };
  if (process.platform !== "win32") return spawn(command, args, settings);
  const env = options.env ?? process.env;
  const executable = resolveCommand(command, options.cwd ?? process.cwd(), env);
  if (!/\.(cmd|bat)$/i.test(executable)) return spawn(executable, args, settings);
  const line = [escapeMeta(executable), ...args.map(quoteArgument)].join(" ");
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    ...settings,
    windowsVerbatimArguments: true,
  });
}
