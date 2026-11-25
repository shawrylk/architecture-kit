import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, openSync, fstatSync, readSync, closeSync } from "node:fs";

const unavailable = () => { throw new Error("Codex invocation unavailable"); };
const produced = new WeakMap();
export const codexNativePinIdentity = pin => produced.get(pin);
// Bounded observation of a runner-selected file; neither authenticity nor atomic execution.
export function codexExecutableSnapshot(executable, native = false) {
  const realpath = realpathSync(executable), fd = openSync(realpath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd), hash = createHash("sha256"), buffer = Buffer.alloc(65536);
    if (!before.isFile() || before.size < 4 || before.size > 512 * 1024 * 1024) unavailable();
    for (let offset = 0; offset < before.size;) {
      const size = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!size) unavailable();
      if (native && offset === 0 && !(process.platform === "linux" ? buffer.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) :
        ["feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(buffer.subarray(0, 4).toString("hex")))) unavailable();
      hash.update(buffer.subarray(0, size)); offset += size;
    }
    const after = fstatSync(fd), current = realpathSync(executable);
    const identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (identity(before) !== identity(after) || current !== realpath) unavailable();
    const selected = fstatPath(realpath);
    if (identity(before) !== identity(selected)) unavailable();
    return { realpath, sha256: hash.digest("hex"), identity: identity(before) };
  } finally { closeSync(fd); }
}
function fstatPath(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return fstatSync(fd); } finally { closeSync(fd); }
}
export function pinCodexNativeExecutable({ command = "codex", cwd, env = process.env } = {}) {
  try {
    if (!["linux", "darwin"].includes(process.platform) || typeof command !== "string" || !command || command.length > 4096 || command.includes("\0") || !path.isAbsolute(cwd)) unavailable();
    let executable;
    for (const directory of command.includes("/") ? [cwd] : (env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
      const candidate = path.resolve(cwd, directory, command);
      try { accessSync(candidate, constants.X_OK); executable = candidate; break; } catch { /* Continue PATH lookup. */ }
    }
    if (!executable) unavailable();
    const before = codexExecutableSnapshot(executable, true);
    const probe = spawnSync(before.realpath, ["--version"], { cwd, env, encoding: "utf8", timeout: 2000, maxBuffer: 1024, shell: false });
    if (probe.error || probe.signal || probe.status !== 0 || !/^codex-cli 0\.172\.0\r?\n?$/.test(probe.stdout) || probe.stderr) unavailable();
    const after = codexExecutableSnapshot(executable, true);
    if (before.identity !== after.identity || before.sha256 !== after.sha256 || before.realpath !== after.realpath) unavailable();
    const pin = Object.freeze({ realpath: before.realpath, version: "0.172.0", sha256: before.sha256 });
    produced.set(pin, before.identity); return pin;
  } catch { unavailable(); }
}
