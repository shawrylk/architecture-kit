import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { dockerRunArgs, fillEnv, freePort, runThrowawayDb, throwawayDefaults } from "./throwaway-db.mjs";

test("a free port skips each port to avoid", async () => {
  const ports = [5432, 55001];
  assert.equal(await freePort([5432], async () => ports.shift()), 55001);
});

test("the OS hands out a real free port that is never 5432", async () => {
  const port = await freePort([5432]);
  assert.ok(Number.isInteger(port) && port > 0 && port !== 5432);
});

test("the env template fills the url, the port, and the rest, and keeps a literal", () => {
  const env = fillEnv({ DATABASE_URL: "{url}", PGPORT: "{port}", LIVE: "1" }, { url: "postgres://u:p@127.0.0.1:55001/app", port: 55001 });
  assert.deepEqual(env, { DATABASE_URL: "postgres://u:p@127.0.0.1:55001/app", PGPORT: "55001", LIVE: "1" });
});

test("the container publishes only on the loopback address", () => {
  const args = dockerRunArgs(throwawayDefaults, "qc-throwaway-1", 55001, generated);
  assert.ok(args.includes("127.0.0.1:55001:5432"));
  assert.equal(args.at(-1), throwawayDefaults.image);
});

const generated = randomBytes(8).toString("hex");

/** A docker that answers each call, and records it. */
function fakeDocker(calls, { readyAfter = 1, runCode = 0 } = {}) {
  let checks = 0;
  return (args) => {
    calls.push(args.slice(0, 2).join(" "));
    if (args[0] === "run") return { code: runCode, err: runCode === 0 ? "" : "no daemon" };
    if (args[0] === "exec") return { code: (checks += 1) > readyAfter ? 0 : 1, err: "" };
    return { code: 0, err: "" };
  };
}

test("the command runs on its own database on a free port, and the container is removed after it", async () => {
  const calls = [];
  let seen = null;
  const code = await runThrowawayDb({ throwawayDb: { env: { LIVE_DB: "1" } } }, ["--", "pnpm", "vitest", "run", "a.test.ts"], {
    docker: fakeDocker(calls),
    open: async () => 55002,
    sleep: async () => {},
    run: async (command, env) => {
      seen = { command, env };
      return 5;
    },
    env: {},
    say: () => {},
    name: "qc-throwaway-test",
    password: generated,
  });
  assert.equal(code, 5);
  assert.equal(seen.command, "pnpm vitest run a.test.ts");
  assert.equal(seen.env.DATABASE_URL, `postgres://postgres:${encodeURIComponent(generated)}@127.0.0.1:55002/app`);
  assert.equal(seen.env.LIVE_DB, "1");
  assert.deepEqual(calls, ["run --detach", "exec qc-throwaway-test", "exec qc-throwaway-test", "rm --force"]);
});

test("an explicit port to avoid is refused, and a docker that cannot start removes nothing", async () => {
  const deps = { docker: fakeDocker([]), open: async () => 55003, sleep: async () => {}, run: async () => 0, env: {}, say: () => {} };
  assert.equal(await runThrowawayDb({}, ["--port", "5432", "--", "x"], deps), 2);
  const calls = [];
  assert.equal(await runThrowawayDb({}, ["--", "x"], { ...deps, docker: fakeDocker(calls, { runCode: 1 }) }), 1);
  assert.deepEqual(calls, ["run --detach"]);
});

test("port 5432 stays avoided when the config lists other ports to avoid", async () => {
  const deps = { docker: fakeDocker([]), open: async () => 55003, sleep: async () => {}, run: async () => 0, env: {}, say: () => {} };
  const config = { throwawayDb: { avoidPorts: [5433] } };
  assert.equal(await runThrowawayDb(config, ["--port", "5432", "--", "x"], deps), 2);
  assert.equal(await runThrowawayDb(config, ["--port", "5433", "--", "x"], deps), 2);
  const opened = [5432, 5433, 55003];
  let next = 0;
  const ports = [];
  const run = async () => 0;
  const docker = (args) => { if (args[0] === "run") ports.push(args[args.indexOf("--publish") + 1]); return { code: 0, err: "" }; };
  await runThrowawayDb(config, ["--", "x"], { ...deps, docker, run, open: async () => opened[next++] });
  assert.deepEqual(ports, ["127.0.0.1:55003:5432"]);
});
