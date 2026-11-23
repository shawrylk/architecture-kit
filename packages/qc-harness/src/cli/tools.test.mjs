import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runTool } from "./tools.mjs";

function capture(overrides = {}) {
  const calls = [];
  return {
    calls,
    options: {
      execPath: "/opt/node/bin/node",
      platform: "linux",
      env: { PATH: "/bin", CUSTOM: "kept" },
      fileExists: (file) => file === "/opt/node/lib/node_modules/npm/bin/npx-cli.js",
      spawn: (...args) => {
        calls.push(args);
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
      ...overrides,
    },
  };
}

test("screens uses the POSIX npm launcher and preserves argv and the caller's env", async () => {
  const { calls, options } = capture();
  const argv = ["--map", "path with 'quotes'.json", "--targets", "left,right", "--help"];
  assert.equal(await runTool("screens", argv, options), 0);
  assert.deepEqual(calls, [["/opt/node/bin/node", [
    "/opt/node/lib/node_modules/npm/bin/npx-cli.js", "--yes", "-p",
    "github:shawrylk/qc-screens#886c303508f4406f397b2221b470115c3cb89589", "qc-screens", ...argv,
  ], { stdio: "inherit", env: { PATH: "/bin", CUSTOM: "kept", npm_config_allow_git: "all" } }]]);
  assert.deepEqual(options.env, { PATH: "/bin", CUSTOM: "kept" });
});

test("stack installs both pinned packages with the Windows npm launcher and keeps an explicit git policy", async () => {
  const { calls, options } = capture({
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
    env: { npm_config_allow_git: "none" },
    fileExists: (file) => file === "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
  });
  assert.equal(await runTool("stack", ["status", "app", "--timeout", "1500"], options), 0);
  assert.deepEqual(calls, [[options.execPath, [
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js", "--yes", "-p",
    "github:shawrylk/qc-stack#e34c270d92e3995b2e512f6eb690ea3cb0bc4699", "-p",
    "github:shawrylk/qc-screens#886c303508f4406f397b2221b470115c3cb89589", "qc-stack",
    "status", "app", "--timeout", "1500",
  ], { stdio: "inherit", env: { npm_config_allow_git: "none" } }]]);
  const emptyPolicy = capture({ env: { npm_config_allow_git: "" } });
  await runTool("stack", [], emptyPolicy.options);
  assert.equal(emptyPolicy.calls[0][2].env.npm_config_allow_git, "");
});

test("throwaway-db falls back to shell-free npx on POSIX and keeps the command separator", async () => {
  const { calls, options } = capture({ fileExists: () => false });
  const argv = ["--port", "auto", "--", "node", "script with spaces.mjs", "a&b"];
  await runTool("throwaway-db", argv, options);
  assert.deepEqual(calls, [["npx", ["--yes", "-p",
    "github:shawrylk/qc-throwaway-db#042fb52425d92ad5f656aa2c18884350ebe4dc08", "qc-throwaway-db", ...argv,
  ], { stdio: "inherit", env: { PATH: "/bin", CUSTOM: "kept", npm_config_allow_git: "all" } }]]);
});

test("the runner passes exit codes, maps signals and spawn errors to 1, and refuses a Windows shell fallback", async () => {
  for (const code of [0, 17, null]) {
    const { options } = capture({ spawn: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", code, code === null ? "SIGTERM" : null));
      return child;
    } });
    assert.equal(await runTool("screens", [], options), code ?? 1);
  }
  const errors = [];
  const failed = capture({
    stderr: (message) => errors.push(message),
    spawn: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    },
  });
  assert.equal(await runTool("screens", [], failed.options), 1);
  assert.match(errors.pop(), /spawn failed/);
  const missing = capture({ platform: "win32", fileExists: () => false, stderr: (message) => errors.push(message) });
  assert.equal(await runTool("screens", [], missing.options), 1);
  assert.equal(errors.pop(), "qc: cannot find npx-cli.js next to node");
  assert.equal(missing.calls.length, 0);
});
