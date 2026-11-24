import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { stateDir } from "./fleet-state.mjs";

const TTL = 600_000;
const validId = value => typeof value === "string" && /^[a-z0-9-]{1,32}$/.test(value);
const validPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
const fresh = (row, now) => row && Number.isFinite(row.seen) && now >= row.seen && now - row.seen <= TTL;
const text = value => typeof value === "string" && value.length > 0 && value.length <= 253 && !/[\x00-\x1f\x7f]/.test(value);
const fieldsOnly = (value, fields) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
const small = value => Buffer.byteLength(JSON.stringify(value)) <= 2048;
function base64(value) {
  if (typeof value !== "string" || !value || value.length > 2800 || Buffer.from(value, "base64").toString("base64") !== value) throw new Error("invalid base64");
  return Buffer.from(value, "base64");
}
function publicKey(value) {
  const key = createPublicKey({ key: base64(value), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "x25519" || key.export({ type: "spki", format: "der" }).toString("base64") !== value) throw new Error("invalid X25519 public key");
  return key;
}
export function createKey() {
  const key = generateKeyPairSync("x25519");
  return { public: key.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    private: key.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
}
export function validateKey(key) {
  if (!key || typeof key !== "object") throw new Error("key must contain an X25519 pair");
  const pub = publicKey(key.public);
  const priv = createPrivateKey({ key: base64(key.private), format: "der", type: "pkcs8" });
  if (priv.asymmetricKeyType !== "x25519" || !createPublicKey(priv).export({ type: "spki", format: "der" }).equals(pub.export({ type: "spki", format: "der" }))) throw new Error("key public and private must match");
  return { public: key.public, private: key.private };
}
const rawKey = value => Buffer.from(publicKey(value).export({ format: "jwk" }).x, "base64url");
const validNonce = value => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
function nonceBytes(value) {
  if (!validNonce(value)) throw new Error("invalid pairing nonce");
  return Buffer.from(value, "hex");
}
export function pairCommit(pub, nonce) {
  return createHash("sha256").update(Buffer.concat([Buffer.from("qc-fleet-commit\n"), rawKey(pub), nonceBytes(nonce)])).digest("hex");
}
export function pairDigest(leader, joiner, lr, r) {
  return createHash("sha256").update(Buffer.concat([Buffer.from("qc-fleet-pair\n"), rawKey(leader), rawKey(joiner), nonceBytes(lr), nonceBytes(r)])).digest();
}
export function pairCode(leader, joiner, lr, r) {
  return String(pairDigest(leader, joiner, lr, r).readUIntBE(0, 6) % 1_000_000).padStart(6, "0");
}
function sharedKey(key, pub, digest) {
  const shared = diffieHellman({ privateKey: createPrivateKey({ key: base64(key.private), format: "der", type: "pkcs8" }), publicKey: publicKey(pub) });
  return hkdfSync("sha256", shared, digest, Buffer.from("qc-fleet-pair"), 32);
}
function read(root, name, fallback) {
  try { return JSON.parse(readFileSync(path.join(stateDir(root), `${name}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
function write(root, name, value) {
  const file = path.join(stateDir(root), `${name}.json`), temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true, maxRetries: 10, retryDelay: 100 }); }
}
export function readPairing(root) {
  const saved = read(root, "pairing", {});
  return { requests: saved.requests ?? {}, offers: saved.offers ?? {} };
}
const readPrivate = root => read(root, "pairing-private", { requests: {}, offers: {}, denied: [] });
const prune = (rows, now) => Object.fromEntries(Object.entries(rows).filter(([, row]) => fresh(row, now)));

export function pairingDecision(root, verb, code, now = Date.now(), { joiner = false } = {}) {
  if (!["allow", "deny", "accept"].includes(verb) || !/^\d{6}$/.test(code ?? "")) throw new Error("pairing needs a 6-digit code");
  const state = readPairing(root), privateState = readPrivate(root);
  const group = verb === "accept" || (verb === "deny" && joiner) ? "offers" : "requests";
  const matches = Object.entries(state[group]).filter(([, row]) => fresh(row, now) && row.code === code);
  if (matches.length !== 1) throw new Error("pairing code is expired, unknown or ambiguous");
  const [id, row] = matches[0], binding = privateState[group][id];
  if (!binding || binding.code !== code) throw new Error("pairing key is unavailable");
  if (verb === "deny" && group === "offers") {
    delete state.offers[id];
    delete privateState.offers[id];
    delete privateState.attempt;
  } else if (verb === "deny") {
    privateState.denied = privateState.denied.filter(row => row.until > now);
    privateState.denied.push({ id, pub: binding.pub, commit: binding.commit, until: now + 3_600_000 });
    delete state.requests[id];
    delete privateState.requests[id];
  } else if (verb === "allow") {
    row.allowed = true;
    binding.allowedAt = now;
  } else row.accepted = true;
  write(root, "pairing-private", privateState);
  write(root, "pairing", state);
}

/** Commit before revealing keys and randomness; users compare the bound code on both PCs. */
export function createPairing({ root, fleet, address, leader = () => false, clock = Date.now, fetch,
  saveSecret = () => { throw new Error("fleet secret persistence is unavailable"); }, warn = () => {} }) {
  function newAttempt(now) {
    const r = randomBytes(16).toString("hex");
    return { r, commit: pairCommit(fleet.key.public, r), leader: null, seen: now };
  }
  let attempt = newAttempt(clock());
  let nextOffer = 0, nextGrant = 0, nextReveal = 0;
  const isLeader = () => Boolean(fleet.secret && leader());
  function syncAttempt(state, privateState, now) {
    const saved = privateState.attempt;
    if (fresh(saved, now) && validNonce(saved.r) && saved.commit === pairCommit(fleet.key.public, saved.r)) {
      attempt = saved;
      return;
    }
    if (saved || attempt.leader || !fresh(attempt, now)) attempt = newAttempt(now);
    state.offers = {};
    privateState.offers = {};
    privateState.attempt = attempt;
    write(root, "pairing-private", privateState);
    write(root, "pairing", state);
  }
  function beacon() {
    const now = clock();
    if (root !== undefined) syncAttempt(readPairing(root), readPrivate(root), now);
    else if (!fresh(attempt, now)) attempt = newAttempt(now);
    return { v: 1, kind: "join", id: fleet.self, port: fleet.nodes.find(node => node.id === fleet.self)?.port ?? 8080,
      address, commit: attempt.commit, hostname: os.hostname(), os: process.platform, time: now };
  }
  function receiveJoin(body, sender) {
    try {
      const now = clock();
      if (!isLeader() || !small(body) || !fieldsOnly(body, ["v", "kind", "id", "port", "address", "commit", "hostname", "os", "time"]) ||
        body.v !== 1 || body.kind !== "join" || !validId(body.id) || body.id === fleet.self || !validPort(body.port) ||
        isIP(body.address) !== 4 || body.address !== sender || !text(body.hostname) || !text(body.os) ||
        !Number.isFinite(body.time) || Math.abs(now - body.time) > 60_000 || typeof body.commit !== "string" || !/^[0-9a-f]{64}$/.test(body.commit)) return false;
      const state = readPairing(root), privateState = readPrivate(root);
      if (privateState.denied.some(row => row.until > now && (row.id === body.id || row.commit === body.commit))) return false;
      state.requests = prune(state.requests, now);
      if (Object.hasOwn(state.requests, body.id) || Object.keys(state.requests).length >= 20) return false;
      state.requests[body.id] = { address: sender, port: body.port, hostname: body.hostname, os: body.os, seen: now, allowed: false };
      privateState.requests = Object.fromEntries(Object.entries(privateState.requests).filter(([id]) => Object.hasOwn(state.requests, id)));
      privateState.requests[body.id] = { commit: body.commit, lr: randomBytes(16).toString("hex") };
      write(root, "pairing-private", privateState);
      write(root, "pairing", state);
      return true;
    } catch (error) { if (error.code && !error.code.startsWith("ERR_")) warn(`fleet pairing: ${error.message}`); return false; }
  }
  function decrypt(body, digest) {
    const nonce = base64(body.nonce), data = base64(body.data);
    if (nonce.length !== 12 || data.length <= 16) throw new Error("bad grant");
    const cipher = createDecipheriv("aes-256-gcm", sharedKey(fleet.key, body.pub, digest), nonce);
    cipher.setAuthTag(data.subarray(-16));
    const value = JSON.parse(Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]).toString("utf8"));
    if (!fieldsOnly(value, ["secret"]) || typeof value.secret !== "string" || !/^[0-9a-f]{64,}$/i.test(value.secret)) throw new Error("bad secret");
    return value.secret;
  }
  function post(row, body) {
    if (!fetch) return Promise.resolve();
    try {
      return Promise.resolve(fetch(`http://${row.address}:${row.port}/pair`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }))
        .catch(error => warn(`fleet pairing: ${error.message}`));
    } catch (error) { warn(`fleet pairing: ${error.message}`); return Promise.resolve(); }
  }
  const reveal = binding => ({ kind: "reveal", id: fleet.self, pub: fleet.key.public, nonce: binding.r });
  function receivePair(body, sender) {
    try {
      if (isIP(sender) !== 4 || !small(body)) return false;
      const now = clock(), state = readPairing(root), privateState = readPrivate(root);
      if (body.kind === "reveal") {
        if (!isLeader() || !fieldsOnly(body, ["kind", "id", "pub", "nonce"]) || !validId(body.id)) return false;
        const row = Object.hasOwn(state.requests, body.id) ? state.requests[body.id] : undefined;
        const binding = privateState.requests[body.id];
        if (!fresh(row, now) || row.address !== sender || !binding || pairCommit(body.pub, body.nonce) !== binding.commit ||
          privateState.denied.some(denied => denied.until > now && (denied.id === body.id || denied.pub === body.pub))) return false;
        const digest = pairDigest(fleet.key.public, body.pub, binding.lr, body.nonce);
        sharedKey(fleet.key, body.pub, digest); // Refuse low-order keys before showing a code.
        if (binding.pub) return binding.pub === body.pub && binding.r === body.nonce;
        const code = pairCode(fleet.key.public, body.pub, binding.lr, body.nonce);
        Object.assign(binding, { pub: body.pub, r: body.nonce, digest: digest.toString("hex"), code });
        row.code = code;
      } else {
        if (fleet.secret || !validId(body.leader) || body.leader === fleet.self) return false;
        syncAttempt(state, privateState, now);
        if (body.kind === "offer") {
          if (!fieldsOnly(body, ["kind", "leader", "pub", "nonce", "port", "time"]) || !validPort(body.port) || !Number.isFinite(body.time) || Math.abs(now - body.time) > 60_000) return false;
          state.offers = prune(state.offers, now);
          if (Object.hasOwn(state.offers, body.leader) || Object.keys(state.offers).length >= 20) return false;
          const digest = pairDigest(body.pub, fleet.key.public, body.nonce, attempt.r);
          sharedKey(fleet.key, body.pub, digest);
          if (attempt.leader) return false;
          const code = pairCode(body.pub, fleet.key.public, body.nonce, attempt.r);
          attempt.leader = body.leader;
          state.offers[body.leader] = { code, address: sender, port: body.port, seen: attempt.seen, accepted: false };
          privateState.offers = Object.fromEntries(Object.entries(privateState.offers).filter(([id]) => Object.hasOwn(state.offers, id)));
          privateState.offers[body.leader] = { pub: body.pub, r: attempt.r, lr: body.nonce, digest: digest.toString("hex"), code };
        } else if (body.kind === "grant") {
          if (!fieldsOnly(body, ["kind", "leader", "pub", "nonce", "data"])) return false;
          const offer = Object.hasOwn(state.offers, body.leader) ? state.offers[body.leader] : undefined;
          const binding = privateState.offers[body.leader];
          if (attempt.leader !== body.leader || binding?.r !== attempt.r || !fresh(offer, now) || offer.address !== sender || binding?.pub !== body.pub || binding.code !== offer.code || !binding.digest) return false;
          decrypt(body, Buffer.from(binding.digest, "hex")); // Authenticate before retaining an encrypted grant.
          binding.grant = body;
          binding.received = now;
        } else return false;
      }
      write(root, "pairing-private", privateState);
      write(root, "pairing", state);
      if (body.kind === "offer") void post(state.offers[body.leader], reveal(privateState.offers[body.leader]));
      return true;
    } catch (error) { if (error.code && !error.code.startsWith("ERR_")) warn(`fleet pairing: ${error.message}`); return false; }
  }
  function signed(id) {
    const state = readPairing(root), privateState = readPrivate(root);
    delete state.requests[id];
    delete privateState.requests[id];
    write(root, "pairing-private", privateState);
    write(root, "pairing", state);
  }
  async function tick() {
    const now = clock(), state = readPairing(root), privateState = readPrivate(root);
    if (!fleet.secret) {
      syncAttempt(state, privateState, now);
      for (const [id, row] of Object.entries(state.offers)) {
        const binding = privateState.offers[id];
        if (id !== attempt.leader || binding?.r !== attempt.r || !fresh(row, now) || row.accepted !== true || !binding?.grant || !fresh({ seen: binding.received }, now) || binding.pub !== binding.grant.pub || binding.code !== row.code) continue;
        const secret = decrypt(binding.grant, Buffer.from(binding.digest, "hex"));
        saveSecret(secret);
        fleet.secret = secret;
        break;
      }
      if (!fleet.secret && fetch && now >= nextReveal) {
        nextReveal = now + 15_000;
        await Promise.all(Object.entries(state.offers).filter(([id, row]) => id === attempt.leader && fresh(row, now) && privateState.offers[id]?.r === attempt.r)
          .map(([id, row]) => post(row, reveal(privateState.offers[id]))));
      }
      return;
    }
    if (!isLeader() || !fetch) return;
    const offersDue = now >= nextOffer, grantsDue = now >= nextGrant;
    if (offersDue) nextOffer = now + 15_000;
    const sends = [];
    for (const [id, row] of Object.entries(state.requests)) {
      const binding = privateState.requests[id];
      if (!fresh(row, now) || !binding?.commit || !validNonce(binding.lr)) continue;
      if (binding.digest && row.allowed === true && binding.allowedAt === undefined) {
        binding.allowedAt = now;
        write(root, "pairing-private", privateState);
      }
      const bodies = [];
      if (offersDue) bodies.push({ kind: "offer", leader: fleet.self, pub: fleet.key.public, nonce: binding.lr, port: fleet.nodes.find(node => node.id === fleet.self)?.port ?? 8080, time: now });
      if (binding.digest && binding.pub && binding.code === row.code && row.allowed === true && grantsDue && Number.isFinite(binding.allowedAt) && now - binding.allowedAt <= TTL) {
        nextGrant = now + 15_000;
        const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", sharedKey(fleet.key, binding.pub, Buffer.from(binding.digest, "hex")), nonce);
        const encrypted = Buffer.concat([cipher.update(JSON.stringify({ secret: fleet.secret })), cipher.final(), cipher.getAuthTag()]);
        bodies.push({ kind: "grant", leader: fleet.self, pub: fleet.key.public, nonce: nonce.toString("base64"), data: encrypted.toString("base64") });
      }
      for (const body of bodies) sends.push(post(row, body));
    }
    await Promise.all(sends);
  }
  return { beacon, receiveJoin, receivePair, signed, tick };
}
