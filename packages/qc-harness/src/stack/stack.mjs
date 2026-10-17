import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { requireLocalhost } from "../screens/map.mjs";

export const stackRoot = () => path.join(os.homedir(), ".qc", "stacks");
export const readRegistry = () => JSON.parse(readFileSync(path.join(os.homedir(), ".qc", "stacks.json"), "utf8"));
export const healthUrls = manifest => typeof manifest.health === "string" ? [manifest.health] : Object.values(manifest.health ?? {});

/** Record: plugins declare local resources before the lifecycle starts. */
export function validateManifest(manifest) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(manifest.name ?? "")) throw new Error("Invalid stack name");
  for (const [name, port] of Object.entries(manifest.ports ?? {})) {
    if (port === 5432) throw new Error("Stack port 5432 is reserved");
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid port ${name}`);
  }
  for (const key of ["up", "down"]) if (typeof manifest[key] !== "string" || !manifest[key]) throw new Error(`Stack requires ${key}`);
  if (!healthUrls(manifest).length) throw new Error("Stack requires health URLs");
  for (const url of healthUrls(manifest)) requireLocalhost(url);
  if (!["form", "auth0-session"].includes(manifest.login?.kind)) throw new Error("Stack login requires form or auth0-session");
  if (manifest.login.kind === "form") requireLocalhost(new URL(manifest.login.url, healthUrls(manifest)[0]).href);
  return manifest;
}

/** Resource: resolve a registered repository without copying its environment. */
export function loadStack(name, registry = readRegistry()) {
  const repo = registry[name];
  if (typeof repo !== "string") throw new Error(`Unknown stack ${name}`);
  const manifest = validateManifest(JSON.parse(readFileSync(path.join(repo, "qc.stack.json"), "utf8")));
  if (manifest.name !== name) throw new Error(`Stack name differs from registry: ${name}`);
  return { repo: path.resolve(repo), manifest };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function portBusy(port) {
  for (const host of ["127.0.0.1", "::1"]) {
    const server = net.createServer();
    const busy = await new Promise((resolve, reject) => {
    server.once("error", error => error.code === "EADDRINUSE" || error.code === "EACCES" ? resolve(true) : reject(error));
      server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(false)));
    });
    if (busy) return true;
  }
  return false;
}

/** Branch: health requires a successful response from every declared endpoint. */
export async function healthy(manifest) {
  const checks = await Promise.all(healthUrls(manifest).map(async url => {
    try { return (await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" })).ok; } catch { return false; }
  }));
  return checks.every(Boolean);
}

/** Resource: commands inherit the repository environment and have a fixed bound. */
export function pluginCommand(command, repo, { timeout = 30000, env = process.env, stdio = "ignore" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: repo, shell: true, windowsHide: true, env, stdio });
    const timer = setTimeout(async () => { await stopTree(child.pid); reject(new Error("Stack command timed out")); }, timeout);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Stack command exited ${code}`)); });
  });
}

/** Resource: stop only the process tree created by the supervisor. */
export async function stopTree(pid) {
  if (!pid || !alive(pid)) return;
  if (process.platform === "win32") await promisify(execFile)("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  else { try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} } }
}

/** Pipeline: persist ownership, wait for health, and compensate failed starts. */
export async function stackAction(action, names = [], { registry = readRegistry(), stateRoot = stackRoot(), timeout = 120000 } = {}) {
  if (!["up", "down", "status"].includes(action)) throw new Error("Choose stack up, down, or status");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const rows = [];
  const entries = (names.length ? names : Object.keys(registry)).map(name => ({ name, ...loadStack(name, registry) }));
  for (const { name, repo, manifest } of entries) {
    const file = path.join(stateRoot, `${name}.json`);
    let state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    let running = Boolean(state?.pid && alive(state.pid) && existsSync(`${file}.${state.token}.live`));
    if (action === "up" && !running) {
      for (const port of Object.values(manifest.ports ?? {})) if (await portBusy(port)) throw new Error(`Stack ${name}: port ${port} is in use`);
      const token = randomUUID();
      state = { repo, manifest, token, startedAt: new Date().toISOString() };
      writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
      const log = openSync(path.join(stateRoot, `${name}.log`), "a", 0o600);
      const worker = spawn(process.execPath, [fileURLToPath(new URL("./supervisor.mjs", import.meta.url)), file], { detached: true, windowsHide: true, stdio: ["ignore", log, log] });
      closeSync(log);
      await new Promise((resolve, reject) => { worker.once("spawn", resolve); worker.once("error", reject); });
      worker.unref();
      const deadline = Date.now() + timeout;
      try {
        while (true) {
          state = JSON.parse(readFileSync(file, "utf8"));
          if (state.error) throw new Error(`Stack ${name}: ${state.error}`);
          if (state.pid && alive(state.pid) && await healthy(manifest)) break;
          if (Date.now() >= deadline) throw new Error(`Stack ${name}: health timed out`);
          await pause(200);
        }
      } catch (error) {
        writeFileSync(`${file}.${token}.stop`, "stop");
        await pause(500);
        throw error;
      }
      running = true;
    }
    if (action === "down" && running) {
      writeFileSync(`${file}.${state.token}.stop`, "stop");
      const deadline = Date.now() + timeout;
      while (alive(state.pid) && existsSync(`${file}.${state.token}.live`)) {
        if (Date.now() > deadline) throw new Error(`Stack ${name}: down timed out`);
        await pause(100);
      }
      rmSync(file, { force: true });
      running = false;
    }
    let pluginHealthy = true;
    if (action === "status" && running && manifest.status) {
      try { await pluginCommand(manifest.status, repo, { timeout: Math.min(timeout, 15000) }); } catch { pluginHealthy = false; }
    }
    rows.push({ name, running, healthy: running && pluginHealthy && await healthy(manifest), baseUrl: healthUrls(manifest)[0], startedAt: state?.startedAt ?? null });
  }
  return rows;
}
