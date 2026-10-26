import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnCommand } from "./spawn-command.mjs";

for (const command of ["probe", "probe.CMD", "probe.BAT"]) {
test(`spawnCommand resolves ${command} and preserves literal shim arguments`, { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "qc-spawn-"));
  const bin = join(root, "bin space");
  mkdirSync(bin);
  writeFileSync(join(bin, "probe"), "#!/bin/sh\nexit 99\n");
  writeFileSync(join(bin, "probe.CMD"), '@echo off\r\n@"' + process.execPath + '" "%~dp0probe.mjs" %*\r\n');
  writeFileSync(join(bin, "probe.BAT"), '@echo off\r\n@"' + process.execPath + '" "%~dp0probe.mjs" %*\r\n');
  writeFileSync(join(bin, "probe.mjs"), "console.log(JSON.stringify(process.argv.slice(2)))");
  const args = ["with spaces", 'with"quote', "with&symbol", "^|<>()%!", "C:\\folder\\file", "ends with space\\", ""];
  try {
    const child = spawnCommand(command, args, {
      cwd: root,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !["PATH", "PATHEXT"].includes(key.toUpperCase()))), Path: root, PATH: bin, Pathext: ".EXE", PATHEXT: ".EXE;.CMD" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { errors += data; });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output), args);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
}

test("spawnCommand forces shell off for native executables", async () => {
  const child = spawnCommand(process.execPath, ["-e", "process.exit(process.argv[1] === '& literal' ? 0 : 1)", "& literal"], { shell: true, stdio: "ignore" });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0);
});

test("spawnCommand rejects line breaks in batch arguments and names the command", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "qc-spawn-newline-"));
  try {
    const shim = join(root, "probe.cmd");
    writeFileSync(shim, "@exit /b 0\r\n");
    for (const argument of ["first\nsecond", "first\rsecond", "first\r\nsecond"]) {
      assert.throws(() => spawnCommand(shim, [argument], { stdio: "ignore" }), (error) => {
        assert.ok(error.message.includes(shim));
        assert.match(error.message, /line break/i);
        return true;
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
