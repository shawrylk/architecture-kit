import { open, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

/** Resource: one process owns each session while it reads, refreshes, and saves. */
export async function withFileLock(file, action, { timeout = 240000 } = {}) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const started = Date.now();
  let handle;
  while (!handle) {
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - started >= timeout) throw new Error("Session lock wait expired");
      await setTimeout(50);
    }
  }
  try { return await action(); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}

/** Resource: readers see either the complete old JSON or the complete new JSON. */
export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}
