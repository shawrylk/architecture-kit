import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";

const LIMIT = 8192;
const unavailable = () => new Error("Codex report channel unavailable");
const deadline = ms => Number.isInteger(ms) && ms > 0 && ms <= 30000;
const fields = ["hook_event_name", "source", "cwd", "session_id", "transcript_path", "model", "permission_mode"];
const startup = input => input && !Array.isArray(input) && Object.keys(input).length === fields.length &&
  fields.every(key => key === "transcript_path" && input[key] === null || typeof input[key] === "string" && input[key].length <= 4096) &&
  input.hook_event_name === "SessionStart" && input.source === "startup";

// Cooperative invocation bearer channel, not native-event attestation. Opaque authority never leaves this closure.
export async function createCodexBridge({ runtime, reservation, timeoutMs = 5000, maxConnections = 4, signal } = {}) {
  if (!runtime || !reservation || !deadline(timeoutMs) || !Number.isInteger(maxConnections) ||
      maxConnections < 1 || maxConnections > 16 || signal?.aborted) throw unavailable();
  const token = randomBytes(32).toString("hex"), sockets = new Set();
  let open = true, closing;
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    if (!open || sockets.size >= maxConnections) { socket.destroy(); return; }
    sockets.add(socket);
    let size = 0, chunks = [];
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { clearTimeout(timer); chunks = []; sockets.delete(socket); });
    socket.on("data", chunk => {
      size += chunk.length;
      if (size > LIMIT) { chunks = []; socket.destroy(); } else chunks.push(chunk);
    });
    socket.once("end", () => {
      try {
        if (!open || socket.destroyed || size > LIMIT) throw unavailable();
        const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        chunks = [];
        if (!request || Object.keys(request).length !== 2 || typeof request.token !== "string" ||
            request.token.length !== token.length || !timingSafeEqual(Buffer.from(request.token), Buffer.from(token)) ||
            !startup(request.input)) throw unavailable();
        runtime.startup(reservation, reservation.hookCredential, request.input);
        socket.end('{"ok":true}'); // Never await ready here: native startup can depend on this acknowledgment.
      } catch { socket.end('{"ok":false}'); }
    });
  });
  server.maxConnections = maxConnections;
  const close = () => {
    if (closing) return closing;
    open = false; signal?.removeEventListener("abort", close);
    for (const socket of sockets) socket.destroy();
    return closing = new Promise(resolve => server.close(resolve));
  };
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    server.on("error", close);
    signal?.addEventListener("abort", close, { once: true });
    if (signal?.aborted) throw unavailable();
    return Object.freeze({ env: Object.freeze({ QC_CODEX_REPORT_PORT: String(server.address().port), QC_CODEX_REPORT_TOKEN: token }),
      ready: () => { if (!open) throw unavailable(); return runtime.ready(reservation); }, close });
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
    const finish = ok => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel); chunks = [];
      socket.destroy();
      if (ok) resolve(null); else reject(unavailable());
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
        finish(reply?.ok === true && Object.keys(reply).length === 1);
      } catch { cancel(); }
    });
    if (signal?.aborted) cancel();
  });
}
