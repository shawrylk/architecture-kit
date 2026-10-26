// `qc throwaway-db -- <command>`: run a command on a database of its own, in a container on a free port.
// It never takes a port the local stack owns, and it removes the container once the command exits.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { parseArgs } from "node:util";
import { merge } from "../config.mjs";
import { commandLine, runInShell, splitAtDashes } from "./child-run.mjs";

export const USAGE = `qc throwaway-db — run a command on a database of its own

  qc throwaway-db [--port <n>|auto] -- <command...>
      start a postgres container on a free port (auto by default), wait until it is ready, run the
      optional schemaCommand, then the command, with the variables of throwawayDb.env filled in,
      and remove the container after.

  qc.config.json "throwawayDb": image, user, database, env (each value may hold {url},
  {host}, {port}, {user}, {password}, {database}), schemaCommand, avoidPorts, and readySeconds. The password is random for each run.`;

export const throwawayDefaults = {
  image: "postgres:17-alpine",
  user: "postgres",
  database: "app",
  env: { DATABASE_URL: "{url}" },
  avoidPorts: [5432],
  readySeconds: 60,
};

const HOST = "127.0.0.1";
const PORT_TRIES = 10;

function listenOnZero() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A port the OS calls free, never one of `avoid`. */
export async function freePort(avoid = [], open = listenOnZero) {
  for (let tries = 0; tries < PORT_TRIES; tries += 1) {
    const port = await open();
    if (!avoid.includes(port)) return port;
  }
  throw new Error(`no free port outside ${avoid.join(", ")} after ${PORT_TRIES} tries`);
}

/** Each variable of the template, with `{name}` replaced by its value; an unknown name stays as written. */
export function fillEnv(template, values) {
  return Object.fromEntries(
    Object.entries(template).map(([name, value]) => [name, String(value).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole))]),
  );
}

/** The `docker run` arguments: a detached container that removes itself, published on the loopback address only. */
export function dockerRunArgs(settings, name, port, password) {
  return [
    "run", "--detach", "--rm", "--name", name, "--publish", `${HOST}:${port}:5432`,
    "--env", `POSTGRES_USER=${settings.user}`, "--env", `POSTGRES_PASSWORD=${password}`, "--env", `POSTGRES_DB=${settings.database}`,
    settings.image,
  ];
}

function dockerSync(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true });
  return { code: result.status ?? 1, err: (result.stderr ?? "").trim() || (result.error?.message ?? "") };
}

/** `qc throwaway-db`. @returns the command's exit code, 1 when the database did not start, or 2 on a usage error */
export async function runThrowawayDb(config, argv, deps = {}) {
  const {
    docker = dockerSync,
    run = runInShell,
    open = listenOnZero,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    env = process.env,
    say = (line) => console.error(line),
    name = `qc-throwaway-${randomBytes(4).toString("hex")}`,
    password = randomBytes(16).toString("hex"),
  } = deps;
  const merged = merge(throwawayDefaults, config.throwawayDb ?? {});
  const settings = { ...merged, avoidPorts: [...new Set([5432, ...merged.avoidPorts])] };
  const { flags, command } = splitAtDashes(argv);
  let port;
  try {
    const { values } = parseArgs({ args: flags, options: { port: { type: "string" } }, strict: true });
    if (command.length === 0) throw new Error("name the command after --");
    const asked = values.port ?? "auto";
    if (asked === "auto") port = await freePort(settings.avoidPorts, open);
    else {
      port = Number(asked);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be auto or a port number, got ${asked}`);
      if (settings.avoidPorts.includes(port)) throw new Error(`port ${port} is in throwawayDb.avoidPorts; use --port auto`);
    }
  } catch (error) {
    say(`qc throwaway-db: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  say(`qc throwaway-db: starting ${name} on port ${port}`);
  const started = docker(dockerRunArgs(settings, name, port, password));
  if (started.code !== 0) {
    say(`qc throwaway-db: docker run failed: ${started.err}`);
    return 1;
  }
  try {
    const deadline = now() + settings.readySeconds * 1000;
    while (docker(["exec", name, "pg_isready", "-h", HOST, "-U", settings.user, "-d", settings.database]).code !== 0) {
      if (now() >= deadline) {
        say(`qc throwaway-db: ${name} was not ready after ${settings.readySeconds} s`);
        return 1;
      }
      await sleep(1000);
    }
    const url = `postgres://${encodeURIComponent(settings.user)}:${encodeURIComponent(password)}@${HOST}:${port}/${settings.database}`;
    const values = { url, host: HOST, port, user: settings.user, password, database: settings.database };
    const commandEnv = { ...env, ...fillEnv(settings.env, values) };
    if (settings.schemaCommand) {
      const code = await run(settings.schemaCommand, commandEnv);
      if (code !== 0) return code;
    }
    return await run(commandLine(command), commandEnv);
  } finally {
    say(`qc throwaway-db: removing ${name}`);
    if (docker(["rm", "--force", name]).code !== 0) say(`qc throwaway-db: remove it by hand: docker rm --force ${name}`);
  }
}
