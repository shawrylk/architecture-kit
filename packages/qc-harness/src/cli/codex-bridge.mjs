import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { codexSessionStartInput } from "./codex-recovery.mjs";
import { codexReportBindingOf } from "./codex-runtime.mjs";

// Match the existing context producer frame bound; startup retains its smaller envelope limit.
const LIMIT = 65536, STARTUP_LIMIT = 8192;
const unavailable = () => new Error("Codex report channel unavailable");
const deadline = ms => Number.isInteger(ms) && ms > 0 && ms <= 30000;
const retirements = new WeakMap();
// Exact genuine server plus original runtime launch; diagnostics carry no authority.
export function codexChannelRetirementOf(bridge, reservation, proof, child) {
  const read = retirements.get(bridge)?.(reservation, proof, child);
  if (!read) throw unavailable();
  return read;
}

// Cooperative invocation bearer channel, not native-event attestation. Opaque authority never leaves this closure.
export async function createCodexBridge({ runtime, reservation, timeoutMs = 5000, maxConnections = 4, signal, onStop, closeOnReject = false } = {}) {
  if (!runtime || !reservation || !deadline(timeoutMs) || !Number.isInteger(maxConnections) ||
      maxConnections < 1 || maxConnections > 16 || signal?.aborted) throw unavailable();
  const token = randomBytes(32).toString("hex"), sockets = new Set();
  let open = true, closing, busy = false, closed, serverClosed = false, routes = 0, operations = 0, binding;
  try { binding = codexReportBindingOf(runtime, reservation); } catch { /* Legacy callers remain unbound. */ }
  const accepting = () => open && (!binding || binding.active());
  const read = Object.freeze(() => Object.freeze({ scope: "original-launched-report-channel",
    state: accepting() ? "open" : serverClosed && routes === 0 && operations === 0 ? "confirmed" : "pending",
    serverClosed, routes, operations }));
  const stopped = new Promise(resolve => { closed = resolve; });
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    if (!accepting() || sockets.size >= maxConnections) { socket.destroy(); if (closeOnReject) void close(); return; }
    sockets.add(socket);
    let size = 0, chunks = [], routing = false, cancelRoute, responded = false;
    const expires = performance.now() + timeoutMs, timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timer); chunks = []; sockets.delete(socket);
      if (routing || closeOnReject && !responded) { cancelRoute?.(); void close(); }
    });
    socket.on("data", chunk => {
      if (!accepting()) { socket.destroy(); return; }
      size += chunk.length;
      if (size > LIMIT) { chunks = []; socket.destroy(); } else chunks.push(chunk);
    });
    socket.once("end", async () => {
      routes++;
      let owned = false;
      const active = () => accepting() && !socket.destroyed && performance.now() < expires;
      const wait = task => {
        operations++;
        // Socket cancellation settles only the route, never this original producer.
        const settled = Promise.resolve(task).then(value => { operations--; return value; }, error => { operations--; throw error; });
        return new Promise((resolve, reject) => {
          cancelRoute = () => reject(unavailable());
          settled.then(resolve, reject);
        });
      };
      try {
        if (!active() || size > LIMIT) throw unavailable();
        const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        chunks = [];
        if (!request || Object.keys(request).length !== 2 || typeof request.token !== "string" ||
            request.token.length !== token.length || !timingSafeEqual(Buffer.from(request.token), Buffer.from(token)) ||
            !request.input || busy) throw unavailable();
        busy = owned = routing = true;
        const input = request.input;
        let output = null;
        if (codexSessionStartInput(input) && size <= STARTUP_LIMIT) {
          if (input.source === "startup") runtime.startup(reservation, reservation.hookCredential, input);
          else output = await wait(runtime.recover(reservation, input, active));
          // Never await ready here: native startup can depend on this acknowledgment.
        } else if (["PreToolUse", "PostToolUse"].includes(input.hook_event_name)) {
          output = await wait(runtime.hook(reservation, input, active));
        } else if (input.hook_event_name === "Stop" && typeof onStop === "function" &&
            typeof input.stop_hook_active === "boolean" && typeof input.turn_id === "string" &&
            /^[A-Za-z0-9_-]{1,128}$/.test(input.turn_id) &&
            typeof input.last_assistant_message === "string" && runtime.validate(reservation, input)) {
          // Fixed runner callback (G handback), never root Stop policy or a payload-selected handler.
          await wait(onStop(input, input.last_assistant_message));
          if (!runtime.validate(reservation, input)) throw unavailable();
        } else throw unavailable();
        if (!active()) throw unavailable();
        const reply = JSON.stringify({ ok: true, output });
        if (Buffer.byteLength(reply) > LIMIT) throw unavailable();
        responded = true; socket.end(reply);
      } catch { if (active()) socket.end('{"ok":false}'); if (closeOnReject || !active()) void close(); }
      finally { routes--; if (owned) busy = routing = false; cancelRoute = undefined; }
    });
  });
  server.maxConnections = maxConnections;
  server.on("drop", () => { if (closeOnReject) void close(); });
  const close = () => {
    if (closing) return closing;
    open = false; signal?.removeEventListener("abort", close);
    binding?.signal.removeEventListener("abort", close);
    for (const socket of sockets) socket.destroy();
    return closing = new Promise(resolve => server.close(() => { serverClosed = true; closed(); resolve(); }));
  };
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    server.on("error", close);
    signal?.addEventListener("abort", close, { once: true });
    if (signal?.aborted) throw unavailable();
    const bridge = Object.freeze({ env: Object.freeze({ QC_CODEX_REPORT_PORT: String(server.address().port), QC_CODEX_REPORT_TOKEN: token }),
      closed: stopped, ready: () => { if (!open) throw unavailable(); return runtime.ready(reservation); }, close });
    retirements.set(bridge, (original, proof, child) => {
      if (original !== reservation || !binding) throw unavailable();
      binding.matches(bridge.env, proof, child); return read;
    });
    binding?.signal.addEventListener("abort", close, { once: true });
    if (binding && !binding.active()) void close();
    return bridge;
  } catch { await close(); throw unavailable(); }
}

// Concrete subprocess client API. A configured, missing or failed channel always rejects; there is no root fallback.
export async function reportCodexHook(input, { env = process.env, timeoutMs = 5000, signal } = {}) {
  const port = env?.QC_CODEX_REPORT_PORT, token = env?.QC_CODEX_REPORT_TOKEN;
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535 || !/^[a-f0-9]{64}$/.test(token) ||
      !deadline(timeoutMs) || signal?.aborted) throw unavailable();
  let request;
  try { request = Buffer.from(JSON.stringify({ token, input })); } catch { throw unavailable(); }
  if (request.length > LIMIT) throw unavailable();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(port) });
    let size = 0, chunks = [], settled = false;
    const expires = performance.now() + timeoutMs;
    const finish = (ok, output) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel); chunks = [];
      socket.destroy();
      if (ok && performance.now() < expires) resolve(output); else reject(unavailable());
    };
    const cancel = () => finish(false), timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    socket.once("connect", () => socket.end(request));
    socket.on("error", cancel); socket.once("close", cancel);
    socket.on("data", chunk => {
      size += chunk.length;
      if (size > LIMIT) cancel(); else chunks.push(chunk);
    });
    socket.once("end", () => {
      try {
        const reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        finish(reply?.ok === true && Object.keys(reply).length === 2 &&
          (reply.output === null || typeof reply.output === "object" && !Array.isArray(reply.output)), reply.output);
      } catch { cancel(); }
    });
    if (signal?.aborted) cancel();
  });
}
