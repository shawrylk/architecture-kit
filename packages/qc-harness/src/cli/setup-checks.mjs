import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const installSteps = {
  node: "Install node 22 or later",
  pnpm: "Install pnpm 10 (run corepack enable)",
  gh: "Install the GitHub CLI (gh)",
  codex: "Install the Codex CLI",
};

/** Resource: run a tool with a bounded wait and no visible Windows console. */
export function runTool(tool, args) {
  const { status, stdout } = spawnSync(tool, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    timeout: 15000,
  });
  return { status, stdout: stdout ?? "" };
}

/** Pipeline: collect the installed tools and their first version lines. */
export function checkTools(run = runTool) {
  return Object.keys(installSteps).map((tool) => {
    const { status, stdout } = run(tool, ["--version"]);
    const found = status === 0;
    return { tool, found, version: found ? stdout.split("\n")[0].trim() : null };
  });
}

/** Resource: read an optional configuration file as text. */
function readOptionalText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Pipeline: list the setup steps that require a person. */
export function personSteps({ tools, home, codexDir, run = runTool, exists = existsSync, readText = readOptionalText }) {
  const steps = [];
  for (const [tool, step] of Object.entries(installSteps)) {
    const check = tools.find((entry) => entry.tool === tool);
    if (!check?.found || (tool === "node" && Number.parseInt(check.version?.replace(/^v/, ""), 10) < 22)) {
      steps.push(step);
    }
  }

  if (tools.some(({ tool, found }) => tool === "gh" && found) && run("gh", ["auth", "status"]).status !== 0) {
    steps.push("Run `gh auth login`");
  }
  if (tools.some(({ tool, found }) => tool === "codex" && found) && !exists(join(codexDir, "auth.json"))) {
    steps.push("Run `codex login`");
  }
  const awsConfig = readText(join(home, ".aws", "config"));
  if (awsConfig === null || !/^\s*sso_(session|start_url)\s*=/m.test(awsConfig)) {
    steps.push("Set up the AWS SSO profile: run `aws configure sso`");
  }
  return steps;
}
