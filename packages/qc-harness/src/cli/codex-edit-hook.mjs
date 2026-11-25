// Pinned to openai/codex rust-v0.172.0 codex-rs/apply-patch/src/{parser,streaming_parser,file_update}.rs.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide as workOrder } from "./work-order-guard.mjs";
import { decide as generated } from "./generated-file-guard.mjs";
import { decide as controller } from "./controller-guard.mjs";
import { decide as reuse } from "./ui-reuse-hint.mjs";
import { decide as slot } from "./slot-guard.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";

const fail = reason => { throw new Error(`Codex patch: ${reason}`); };
const nonempty = chunk => chunk && (chunk.old.length || chunk.next.length);
// Rust str::trim[_end] uses Unicode White_Space: includes U+0085, excludes U+FEFF.
const rustTrimEnd = value => value.replace(/\p{White_Space}+$/u, "");
const rustTrim = value => rustTrimEnd(value.replace(/^\p{White_Space}+/u, ""));
const localPath = (cwd, value) => {
  if (!value || /[\0\r\n]/.test(value) || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) fail("unsupported local path");
  return path.resolve(cwd, value);
};

/** Parse data only: filenames are literal, never shell words or quoted-path escapes. */
export function parseCodexPatch(input, cwd) {
  if (typeof input !== "string") fail("expected tool_input.command patch string");
  let lines = rustTrim(input).split(/\r?\n/);
  if (["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0]) && lines.at(-1).endsWith("EOF")) lines = lines.slice(1, -1);
  if (!lines.length || rustTrim(lines[0]) !== "*** Begin Patch" || rustTrim(lines.at(-1)) !== "*** End Patch") fail("invalid patch boundaries");
  const operations = [];
  let op, chunk;
  const finish = () => {
    if (op?.kind === "update" && (!op.chunks.length || !nonempty(chunk))) fail("empty update chunk");
  };
  for (const line of lines.slice(1, -1)) {
    const marker = op?.kind === "update" ? rustTrimEnd(line) : rustTrim(line);
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(marker);
    if (header) {
      finish();
      op = { kind: header[1].toLowerCase(), file: localPath(cwd, header[2]), content: "", chunks: [] };
      operations.push(op); chunk = null;
    } else if (op?.kind === "add" && line.startsWith("+")) {
      op.content += `${line.slice(1)}\n`;
    } else if (op?.kind === "update") {
      if (marker.startsWith("*** Move to: ") && !op.chunks.length && !op.destination) {
        op.destination = localPath(cwd, marker.slice(13)); continue;
      }
      if (chunk?.eof && !marker) continue;
      if (marker === "@@" || marker.startsWith("@@ ")) {
        if (chunk && !nonempty(chunk)) fail("empty update chunk");
        chunk = { old: [], next: [], skip: marker === "@@" ? null : marker.slice(3), eof: false };
        op.chunks.push(chunk); continue;
      }
      if (chunk?.eof) fail("expected a new chunk after end of file");
      if (marker === "*** End of File") {
        if (!nonempty(chunk)) fail("empty end-of-file chunk");
        chunk.eof = true; continue;
      }
      if (line !== "" && ![" ", "+", "-"].includes(line[0])) fail("unsupported update line");
      if (!chunk) { chunk = { old: [], next: [], skip: null, eof: false }; op.chunks.push(chunk); }
      if (!line || line[0] !== "+") chunk.old.push(line.slice(1));
      if (!line || line[0] !== "-") chunk.next.push(line.slice(1));
    } else fail("unsupported patch operation");
  }
  finish();
  const paths = operations.flatMap(one => [one.file, ...(one.destination ? [one.destination] : [])]);
  const keys = paths.map(file => process.platform === "win32" ? file.toLowerCase() : file);
  if (new Set(keys).size !== keys.length) fail("overlapping patch paths are unsupported");
  return operations;
}

/** Exact, uniform-line-ending preview; fuzzy or mixed-ending updates fail closed instead of guessing. */
function preview(op) {
  const text = readFileSync(op.file, "utf8"), eol = text.includes("\r\n") ? "\r\n" : "\n";
  const source = text.split(eol);
  if (text.endsWith(eol) || !text) source.pop();
  if (source.some(line => /[\r\n\0]/.test(line))) fail("mixed endings or binary update unsupported");
  let cursor = 0;
  const changes = [];
  const seek = (pattern, eof = false) => {
    const start = eof ? Math.max(cursor, source.length - pattern.length) : cursor;
    for (let i = start; i <= source.length - pattern.length; i++) {
      if (pattern.every((line, n) => source[i + n] === line)) return i;
    }
    fail("update requires unsupported fuzzy matching or missing source context");
  };
  for (const chunk of op.chunks) {
    if (chunk.skip !== null) cursor = seek([chunk.skip]) + 1;
    const at = chunk.old.length ? seek(chunk.old, chunk.eof) : source.length;
    changes.push([at, chunk.old.length, chunk.next]);
    if (chunk.old.length) cursor = at + chunk.old.length;
  }
  for (const [at, count, next] of changes.reverse()) source.splice(at, count, ...next);
  return source.length ? source.join(eol) + eol : "";
}

/** Invoke the existing fast gate unchanged; all errors describe an edit that has already happened. */
function postGate(call, operations, run) {
  const hook = fileURLToPath(new URL("../../../../hooks/post-edit-gate.sh", import.meta.url));
  const notes = [], errors = [];
  for (const file_path of operations.flatMap(op => [op.file, ...(op.destination ? [op.destination] : [])])) {
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file_path)) continue;
    try {
      const result = run("bash", [hook], { cwd: call.cwd, encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(hook)) },
        input: JSON.stringify({ ...call, tool_input: { file_path } }) });
      if (result.error || result.status !== 0) errors.push(result.error?.message ?? `${result.stderr ?? ""}${result.stdout ?? ""}`);
      else if (result.stdout?.trim()) {
        const output = JSON.parse(result.stdout);
        if (output.hookSpecificOutput?.additionalContext) notes.push(output.hookSpecificOutput.additionalContext);
      }
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) fail(`post-edit gate failed; edit already happened: ${errors.join("\n")}${notes.length ? `\n${notes.join(" ")}` : ""}`);
  return notes.length ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notes.join(" ") } } : null;
}

/** Fan out to the unchanged shared policies; a denial rejects the entire tool call. */
export async function decideCodexEdit(call, { editGuards = [edit => workOrder(edit, checkoutRootOf(edit.cwd) ?? edit.cwd), generated, edit => controller(edit), reuse, edit => slot(edit)], postEdit = spawnSync } = {}) {
  if (call.hook_event_name === "PostToolUse") {
    try { return postGate(call, parseCodexPatch(call.tool_input.command, call.cwd), postEdit); }
    catch (error) { fail(`post-edit evaluation failed; edit already happened: ${error.message}`); }
  }
  const operations = parseCodexPatch(call.tool_input.command, call.cwd);
  const writes = operations.flatMap(op => {
    const content = op.kind === "update" ? preview(op) : op.content;
    return op.destination ? [[op.file, ""], [op.destination, content]] : [[op.file, content]];
  });
  const notes = [];
  for (const [file_path, content] of writes) {
    const edit = { ...call, tool_name: "Write", tool_input: { file_path, content } };
    for (const decide of editGuards) {
      const result = (await decide(edit, call.cwd))?.hookSpecificOutput;
      if (writes.length > 1 && result?.additionalContext?.startsWith("Direct lane:")) {
        fail(`multi-path controller preview unsupported; split this patch. ${result.additionalContext}`);
      }
      if (result?.additionalContext) notes.push(result.additionalContext);
      if (result?.permissionDecision === "deny") return { hookSpecificOutput: { ...result,
        ...(notes.length ? { additionalContext: notes.join(" ") } : {}) } };
    }
  }
  return notes.length ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notes.join(" ") } } : null;
}
