import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { pluginCommand, stopTree } from "./stack.mjs";

const file = process.argv[2];
const state = JSON.parse(readFileSync(file, "utf8"));
const live = `${file}.${state.token}.live`;
const stop = `${file}.${state.token}.stop`;
state.pid = process.pid;
writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
writeFileSync(live, state.token, { mode: 0o600 });
const child = spawn(state.manifest.up, { cwd: state.repo, shell: true, detached: process.platform !== "win32", windowsHide: true, stdio: "inherit" });
child.on("error", () => { state.error = "Cannot start plugin command"; writeFileSync(file, JSON.stringify(state)); });
child.on("exit", code => { if (code) { state.error = `Plugin exited ${code}`; writeFileSync(file, JSON.stringify(state)); } });
let refreshing = false;
const timer = setInterval(async () => {
  if (existsSync(stop)) {
    clearInterval(timer);
    try { await pluginCommand(state.manifest.down, state.repo); }
    finally { await stopTree(child.pid); rmSync(live, { force: true }); rmSync(stop, { force: true }); process.exit(0); }
  }
  if (!refreshing && state.manifest.login.kind === "auth0-session") {
    refreshing = true;
    try {
      const { refreshStackSessions } = await import("../screens/stack-auth.mjs");
      await refreshStackSessions(state.manifest.name);
    } catch { /* The next interval retries an unavailable session. */ }
    finally { refreshing = false; }
  }
}, 1000);
