import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const KINDS = Object.freeze(["assign", "plan", "approve", "question", "answer", "pushed", "verdict", "platform-check", "platform-result", "heartbeat", "propose-leader", "leader"]);
const plain = value => value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validSecret = secret => typeof secret === "string" && secret.length >= 64 && !/[^0-9a-f]/i.test(secret);

/** Canonical JSON for wire data: sort object keys recursively, preserving array order. */
export function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, item => canonical(item)).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  throw new TypeError("message must contain only JSON data");
}

function signature(unsigned, secret) {
  if (!validSecret(secret)) throw new TypeError("secret must be hex with at least 64 characters");
  // Use the complete shared hex text as the key, including odd-length secrets.
  return createHmac("sha256", secret).update(canonical(unsigned)).digest("hex");
}

/** Create a signed data envelope; no body fields are interpreted as instructions. */
export function createMessage(fields, secret) {
  const { sig: _sig, ...unsigned } = { v: 1, id: randomUUID(), time: new Date().toISOString(), ...fields };
  return { ...unsigned, sig: signature(unsigned, secret) };
}

/** Return a named refusal, or accept and remember the ID in the caller's seen state. */
export function verifyMessage(message, { secret, nodes = [], seen = {}, now = Date.now() } = {}) {
  const refuse = reason => ({ ok: false, reason });
  try {
    if (!plain(message)) return refuse("bad-message");
    const { sig, ...unsigned } = message;
    if (typeof sig !== "string" || sig.length !== 64 || /[^0-9a-f]/i.test(sig) || !validSecret(secret)) return refuse("bad-signature");
    if (!plain(message.body)) return refuse("bad-body");
    const expected = signature(unsigned, secret);
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return refuse("bad-signature");
    if (message.v !== 1) return refuse("bad-version");
    if (typeof message.id !== "string" || !message.id) return refuse("bad-id");
    if (!nodes.some(node => node.id === message.from)) return refuse("unknown-sender");
    if (!KINDS.includes(message.kind)) return refuse("unknown-kind");
    if (typeof message.repo !== "string" || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(message.repo) || message.repo.trim() !== message.repo) return refuse("bad-repo");
    const time = typeof message.time === "string" ? Date.parse(message.time) : NaN;
    if (!Number.isFinite(time) || !Number.isFinite(now) || Math.abs(now - time) > 300_000) return refuse("bad-time");
    if (Object.hasOwn(seen, message.id)) return refuse("seen-id");
    Object.defineProperty(seen, message.id, { value: now, enumerable: true, writable: true, configurable: true });
    return { ok: true };
  } catch {
    return refuse("bad-message");
  }
}
