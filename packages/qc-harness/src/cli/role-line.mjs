import { createHmac, timingSafeEqual } from "node:crypto";

export const ROLES = Object.freeze(["Leader", "Coder", "Reviewer"]);
const roles = ROLES.map((role) => role.toLowerCase());
const token = /^[a-zA-Z0-9_-]+$/;
const reference = /^#[1-9]\d*$/;
const signature = (secret, { role, node, kind, ref }, body) => createHmac("sha256", secret)
  .update(`qc:v1|${role}|${node}|${kind}|${ref}|${body}`).digest("hex");

/** Format a public role heading and a private, optionally authenticated marker. */
export function roleComment({ role, node, kind, ref, summary, body }, { secret } = {}) {
  if (!roles.includes(role) || !token.test(kind ?? "") || !reference.test(ref ?? "")
    || typeof summary !== "string" || /[\r\n]|-->/.test(summary)
    || typeof body !== "string" || body.includes("-->")
    || (secret && !token.test(node ?? ""))) throw new Error("Invalid role comment");
  const fields = { role, node, kind, ref };
  const auth = secret ? ` n=${node}` : "";
  const sig = secret ? ` sig=${signature(secret, fields, body)}` : "";
  return `**${ROLES[roles.indexOf(role)]}** · ${summary}\n\n${body}\n\n<!-- qc:v1 role=${role}${auth} kind=${kind} ref=${ref}${sig} -->`;
}

/** Read only a final marker from our own author; authenticate fleet comments. */
export function parseMarker(text, { secret, nodes = [], ownAuthor } = {}) {
  const refuse = (reason) => ({ refused: reason });
  if (ownAuthor !== true) return refuse("not-own-author");
  const trimmed = typeof text === "string" ? text.trimEnd() : "";
  const marker = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  if (!marker.startsWith("<!-- qc:v1")) return refuse("missing-marker");
  const match = /^<!-- qc:v1 role=(leader|coder|reviewer)(?: n=([\w-]+))? kind=([\w-]+) ref=(#[1-9]\d*)(?: sig=([a-fA-F0-9]*))? -->$/.exec(marker);
  if (!match) return refuse("invalid-marker");
  const [, role, node, kind, ref, sig] = match;
  if (!node && sig === undefined) {
    return secret ? refuse("signature-required") : { role, kind, ref };
  }
  if (!node || sig === undefined) return refuse("invalid-marker");
  if (!secret) return refuse("secret-required");
  if (!nodes.includes(node)) return refuse("unknown-node");
  const prefix = trimmed.slice(0, -marker.length);
  const heading = `**${ROLES[roles.indexOf(role)]}** · `;
  const split = prefix.indexOf("\n\n");
  if (!prefix.startsWith(heading) || split < 0 || !prefix.endsWith("\n\n")
    || /[\r\n]|-->/.test(prefix.slice(heading.length, split))) return refuse("invalid-marker");
  const body = prefix.slice(split + 2, -2);
  if (body.includes("-->")) return refuse("invalid-marker");
  const expected = Buffer.from(signature(secret, { role, node, kind, ref }, body), "hex");
  const actual = Buffer.from(sig, "hex");
  if (sig.length !== 64 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return refuse("invalid-signature");
  return { role, node, kind, ref, sig };
}
