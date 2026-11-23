import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// The tool pins live together so upgrades change one table.
const TOOLS = {
  stack: { repo: "shawrylk/qc-stack", sha: "e34c270d92e3995b2e512f6eb690ea3cb0bc4699", bin: "qc-stack" },
  screens: { repo: "shawrylk/qc-screens", sha: "fd718fd131fef2af4f64d0d25e41675dc12bbe94", bin: "qc-screens" },
  "throwaway-db": { repo: "shawrylk/qc-throwaway-db", sha: "042fb52425d92ad5f656aa2c18884350ebe4dc08", bin: "qc-throwaway-db" },
};

/** Runs a pinned tool without passing its arguments through a shell. */
export async function runTool(command, argv, {
  spawn: spawnChild = spawn,
  fileExists = existsSync,
  execPath = process.execPath,
  platform = process.platform,
  env = process.env,
  stderr = console.error,
} = {}) {
  const tool = TOOLS[command];
  const paths = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = paths.dirname(execPath);
  const npmCli = [
    paths.join(nodeDir, "node_modules/npm/bin/npx-cli.js"),
    paths.join(nodeDir, "../lib/node_modules/npm/bin/npx-cli.js"),
  ].find(fileExists);
  if (!npmCli && platform === "win32") {
    stderr("qc: cannot find npx-cli.js next to node");
    return 1;
  }
  const args = ["--yes"];
  for (const pkg of command === "stack" ? [tool, TOOLS.screens] : [tool]) {
    args.push("-p", `github:${pkg.repo}#${pkg.sha}`);
  }
  args.push(tool.bin, ...argv);
  const childEnv = { ...env };
  if (childEnv.npm_config_allow_git === undefined) childEnv.npm_config_allow_git = "all";
  return new Promise((resolve) => {
    const child = spawnChild(npmCli ? execPath : "npx", npmCli ? [npmCli, ...args] : args, {
      stdio: "inherit", env: childEnv,
    });
    child.on("error", (error) => {
      stderr(`qc: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
