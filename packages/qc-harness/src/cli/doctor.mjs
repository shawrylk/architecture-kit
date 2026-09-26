// The harness runs from two places at once: the plugin's hooks execute a checkout of this kit,
// while `pnpm check` and CI execute the copy the lockfile pins. When those disagree, the hooks
// judge a repository by a rulebook it was never built against, and every failure names the
// repository's own files -- so the obvious reading is that the repository is broken. It is not.
//
// This names the disagreement instead, which is the only cheap moment to catch it.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { hookDrift } from "./git-hooks.mjs";

const execFileAsync = promisify(execFile);

/** @returns the gate names a harness copy ships, or null when there is no such copy. */
export function gateNames(harnessRoot, read = readdirSync) {
  let entries;
  try {
    entries = read(path.join(harnessRoot, "src", "gates"));
  } catch {
    return null;
  }
  return entries
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .map((name) => name.replace(/\.mjs$/, ""))
    .sort();
}

export function versionOf(harnessRoot) {
  const file = path.join(harnessRoot, "package.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")).version ?? null;
}

/**
 * The decision, as data. Direction is the whole point: a plugin copy *behind* the lockfile judges
 * a repository by a rulebook it was never built against, and its failures name the repository's
 * own files -- that verdict is worthless and has to stop the turn. A copy *ahead* is what every
 * day of developing this kit looks like; it is merely stricter, and anything it reports is a real
 * finding to act on. Blocking on that direction would make the kit unable to grow.
 * A plugin whose hooks run the installed copy never judges the repository with its own gates, so
 * a copy behind is then a note.
 * @returns null when the two agree, else a report carrying `blocking`.
 */
export function drift(installed, plugin, { hooksRunInstalled = false } = {}) {
  if (!plugin || !installed) return null;
  const missing = installed.gates.filter((name) => !plugin.gates.includes(name));
  const extra = plugin.gates.filter((name) => !installed.gates.includes(name));
  if (missing.length === 0 && extra.length === 0 && installed.version === plugin.version) return null;
  return {
    missing,
    extra,
    blocking: missing.length > 0 && !hooksRunInstalled,
    installedVersion: installed.version,
    pluginVersion: plugin.version,
  };
}

export function driftReport(found, pluginRoot, checkoutRoot = pluginRoot) {
  const behindOnly = found.missing.length > 0 && !found.blocking;
  const label = found.blocking ? "FAIL  harness     " : behindOnly ? "NOTE  harness     " : "WARN  harness     ";
  const lines = [
    `${label} the hooks and the lockfile run different harnesses`,
    `      installed    ${found.installedVersion ?? "?"} — what \`pnpm check\` and CI enforce`,
    `      plugin       ${found.pluginVersion ?? "?"} — what the agent hooks enforce, from ${pluginRoot}`,
  ];
  if (behindOnly) {
    lines.push(`      the plugin copy is missing: ${found.missing.join(", ")}`);
    lines.push(`      the hooks run the installed copy, so the structure check is unaffected`);
    lines.push(`      update the plugin and restart the session to get its newer guards`);
  } else if (found.missing.length > 0) {
    lines.push(`      the plugin copy is missing: ${found.missing.join(", ")}`);
    lines.push(`      so its \`qc check\` reports unknown-check for rules your docs correctly list`);
    lines.push(`      fix the checkout, never the repository: git -C ${checkoutRoot} log --oneline -1`);
  }
  if (found.extra.length > 0) {
    lines.push(`      the plugin copy adds: ${found.extra.join(", ")}`);
    lines.push(`      it is ahead, not stale — anything it reports is real. Bump the lockfile to ship it.`);
  }
  return lines.join("\n");
}

/** @returns the branch position of a checkout against its own remote, or null when unavailable. */
async function behindMain(root) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-list", "--left-right", "--count", "origin/HEAD...HEAD"], {
      cwd: root,
    });
    const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
    return { behind, ahead };
  } catch {
    return null;
  }
}

/** True when the plugin's stop gate prefers the repository's installed harness over its own copy. */
export function hooksRunInstalled(pluginCheckout, read = readFileSync) {
  try {
    return read(path.join(pluginCheckout, "hooks", "stop-gate.sh"), "utf8").includes(
      "node_modules/architecture-harness/src/cli/qc.mjs",
    );
  } catch {
    return false;
  }
}

function pluginHarnessRoot() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return null;
  const harness = path.join(root, "packages", "qc-harness");
  return existsSync(harness) ? harness : null;
}

function installedHarnessRoot(configRoot) {
  const dir = path.join(configRoot, "node_modules", "architecture-harness");
  return existsSync(dir) ? dir : null;
}

export async function runDoctor(config) {
  const hooksFailed = reportHooks(config);
  const harnessCode = await compareHarnesses(config);
  return hooksFailed ? 1 : harnessCode;
}

/** @returns true when an installed git hook lacks a call `hooks.required` names. */
function reportHooks(config) {
  const { problems, notes } = hookDrift(config.root, config.hooks?.required ?? {});
  for (const problem of problems) console.error(`FAIL  hooks        ${problem.path}: ${problem.detail}`);
  for (const note of notes) console.log(`NOTE  hooks        ${note}`);
  if (problems.length === 0) console.log("OK  hooks        each git hook makes the calls hooks.required names");
  return problems.length > 0;
}

async function compareHarnesses(config) {
  const installedRoot = installedHarnessRoot(config.root);
  const pluginRoot = pluginHarnessRoot();

  if (!installedRoot) {
    console.log("SKIP  harness      no architecture-harness in node_modules — nothing to compare");
    return 0;
  }
  const installed = { gates: gateNames(installedRoot), version: versionOf(installedRoot) };
  console.log(`OK  installed    architecture-harness ${installed.version} — ${installed.gates.length} gate(s)`);

  if (!pluginRoot) {
    console.log("SKIP  plugin       CLAUDE_PLUGIN_ROOT is unset — run this from an agent session to compare");
    return 0;
  }
  const plugin = { gates: gateNames(pluginRoot), version: versionOf(pluginRoot) };
  const checkoutRoot = path.resolve(pluginRoot, "..", "..");
  const position = await behindMain(checkoutRoot);
  const found = drift(installed, plugin, { hooksRunInstalled: hooksRunInstalled(checkoutRoot) });
  if (!found) {
    console.log(`OK  plugin       the same ${plugin.gates.length} gate(s) as the lockfile pins`);
    return 0;
  }
  const report = driftReport(found, pluginRoot, checkoutRoot);
  const note =
    position && position.behind > 0
      ? `\n      that checkout is ${position.behind} commit(s) behind its origin, ${position.ahead} ahead`
      : "";
  if (!found.blocking) {
    console.log(`${report}${note}`);
    return 0;
  }
  console.error(`${report}${note}`);
  return 1;
}
