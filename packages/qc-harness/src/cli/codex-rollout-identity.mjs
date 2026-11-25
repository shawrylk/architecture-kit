// SessionMeta proof: openai/codex 3d86e43b (0.172.0), rollout/src/recorder.rs:983-1007.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HEAD = 65536;
const whole = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
function rowMetadata(row, now, timestamp = 0, ordinal = -1) {
  const time = Date.parse(row?.timestamp);
  return object(row) && object(row.payload) && typeof row.timestamp === "string" && Number.isFinite(time) &&
    time >= timestamp && time <= now && whole(row.ordinal) && row.ordinal > ordinal;
}

// Internal synchronous boundary: consumers finish on the same descriptor before race checks and close.
export function withCodexRollout(input, { codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), now = Date.now() } = {}, consume) {
  let fd;
  try {
    const { transcriptPath, checkout, threadId } = input;
    if (!Number.isSafeInteger(now) || !id(threadId) || typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath) ||
        !transcriptPath.endsWith(".jsonl") || typeof checkout !== "string" || !path.isAbsolute(checkout)) return null;
    const root = realpathSync(path.join(codexHome, "sessions")), file = realpathSync(transcriptPath);
    const relative = path.relative(root, file), selected = lstatSync(transcriptPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || selected.isSymbolicLink()) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || !sameFile(selected, before)) return null;
    const key = createHash("sha256").update(`${file}:${before.dev}:${before.ino}`).digest("hex");
    const read = (start, length) => {
      const buffer = Buffer.alloc(length);
      if (readSync(fd, buffer, 0, length, start) !== length) throw new Error("incomplete source");
      return buffer;
    };
    const head = read(0, Math.min(HEAD, before.size)), newline = head.indexOf(10);
    if (newline < 0) return null;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const first = JSON.parse(decoder.decode(head.subarray(0, newline))), meta = first?.payload;
    const validRow = (row, timestamp, ordinal) => rowMetadata(row, now, timestamp, ordinal);
    if (!validRow(first) || first.type !== "session_meta" || !id(meta.id) || !id(meta.session_id) || meta.id !== threadId ||
        meta.cli_version !== "0.172.0" || typeof meta.cwd !== "string" || meta.forked_from_id != null || meta.history_base != null ||
        realpathSync(meta.cwd) !== realpathSync(checkout)) return null;
    const spawn = meta.source?.subagent?.thread_spawn;
    const source = ["cli", "exec", "vscode"].includes(meta.source) ? meta.source :
      spawn && id(spawn.parent_thread_id) && id(spawn.agent_role) && whole(spawn.depth) && spawn.depth >= 1 ? "thread_spawn" : null;
    if (!source) return null;
    const result = consume({ meta, first, source, before, key, decoder, read, validRow });
    const after = fstatSync(fd), current = lstatSync(transcriptPath);
    if (!sameFile(before, after) || !sameFile(before, current) || current.isSymbolicLink() || realpathSync(transcriptPath) !== file ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return null;
    return result;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Local-file observation for cooperative hooks; same-user writers can forge it. No role/settings authority. */
export function readCodexRolloutIdentity(input, options) {
  return withCodexRollout(input, options, ({ meta, first, source, before, key }) => ({
    nativeRootSessionId: meta.session_id, nativeThreadId: meta.id, source,
    provenance: "codex-0.172.0/session_meta/local-file",
    fileIdentity: { file: key, bytes: before.size, timestamp: Date.parse(first.timestamp), ordinal: first.ordinal },
  }));
}
