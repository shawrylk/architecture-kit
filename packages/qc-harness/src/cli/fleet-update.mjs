import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readState, stateDir, writeState } from "./fleet-state.mjs";

export const KIT_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export const validKitVersion = value => typeof value === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);

// Runs after the old node stops, because the new node needs the same port. If the new version does not start, the old version starts again.
const HELPER = `
const { spawnSync } = require("node:child_process");
const [pid, version, leader, mode, oldQc] = process.argv.slice(1);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === "EPERM"; } };
const until = Date.now() + 60000;
(function wait() {
  if (alive() && Date.now() < until) return setTimeout(wait, 200);
  const args = ["fleet", "start", ...(leader === "1" ? ["--leader"] : []), "--jobs", mode];
  const win = process.platform === "win32";
  const next = spawnSync(win ? "npx.cmd" : "npx", ["--yes", "architecture-harness@" + version, ...args], { stdio: "inherit", shell: win });
  if (next.status === 0) return;
  console.error("fleet update: version " + version + " did not start; the old version starts again");
  spawnSync(process.execPath, [oldQc, ...args], { stdio: "inherit" });
})();
`;

/** Save the version that the leader asked for. The node takes no new job, and it changes version when its live jobs end. */
export function requestUpdate(root, version) {
  if (!validKitVersion(version) || version === KIT_VERSION) return false;
  writeState(root, "node", { ...readState(root, "node"), update: { version } });
  return true;
}
export const pendingUpdate = root => { const version = readState(root, "node").update?.version; return validKitVersion(version) ? version : undefined; };

/** Start the helper that waits for this process to stop and then starts the new version. The caller stops the node next. */
export function startUpdate({ root, version, leader, mode, pid = process.pid, env = process.env, run = spawn }) {
  if (!validKitVersion(version)) throw new Error("invalid kit version");
  const log = openSync(path.join(stateDir(root), "node.log"), "a", 0o600);
  try {
    const child = run(process.execPath, ["-e", HELPER, String(pid), version, leader ? "1" : "0", String(mode), fileURLToPath(new URL("./qc.mjs", import.meta.url))],
      { cwd: root, env, detached: true, stdio: ["ignore", log, log], windowsHide: true });
    child.unref();
  } finally { closeSync(log); }
}
