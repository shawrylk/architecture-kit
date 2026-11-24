import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createSocket as udpSocket } from "node:dgram";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { canonical } from "./fleet-message.mjs";
import { stateDir } from "./fleet-state.mjs";

const validId = id => typeof id === "string" && /^[a-z0-9-]{1,32}$/.test(id);
const validPort = port => Number.isInteger(port) && port >= 1024 && port <= 65535;
const validCapacity = node => Number.isFinite(node.weight) && node.weight > 0 && node.weight <= 100 && ["S", "M", "L"].includes(node.maxSize);
const localIPv4 = interfaces => Object.values(interfaces()).flat().filter(row =>
  row && !row.internal && row.family === "IPv4" && isIP(row.address) === 4);
const mac = (fields, secret) => createHmac("sha256", Buffer.from(secret, "utf8")).update(canonical(fields)).digest("hex");

const fingerprint = secret => createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16);

/** Discovery state shares the fleet's private git state directory and secret identity. */
export function readDiscovered(root, secret) {
  try {
    const saved = JSON.parse(readFileSync(path.join(stateDir(root), "discovered.json"), "utf8"));
    return typeof secret === "string" && saved?.fleet === fingerprint(secret) &&
      saved.nodes && typeof saved.nodes === "object" && !Array.isArray(saved.nodes) ? saved.nodes : {};
  }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

function saveDiscovered(root, secret, nodes) {
  const discovered = { fleet: fingerprint(secret), nodes };
  const file = path.join(stateDir(root), "discovered.json");
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${JSON.stringify(discovered, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true, maxRetries: 10, retryDelay: 100 }); }
}

/** A fresh, signed announcement always fits a single small UDP datagram. */
export function createBeacon({ fleet, clock = Date.now, interfaces = os.networkInterfaces }) {
  const self = fleet.nodes.find(node => node.id === fleet.self);
  const address = self.address ?? localIPv4(interfaces)[0]?.address;
  if (!address) throw new Error(`fleet address is required for ${fleet.self}`);
  const fields = { v: 1, id: fleet.self, port: self.port ?? 8080, addresses: [address], weight: self.weight ?? 1,
    maxSize: self.maxSize ?? "L", time: clock(), nonce: randomBytes(16).toString("hex") };
  return { ...fields, sig: mac(fields, fleet.secret) };
}

/** Static files keep their identity; discovery adds only recent, unconfigured peers. */
export function effectiveFleet(fleet, discovered, now = Date.now(), interfaces = os.networkInterfaces) {
  if (!fleet.discover) return fleet;
  const nodes = fleet.nodes.map(node => node.id === fleet.self && !node.address
    ? { ...node, address: localIPv4(interfaces)[0]?.address } : node);
  const named = new Set(nodes.map(node => node.id));
  for (const [id, row] of Object.entries(discovered)) {
    if (named.has(id) || !validId(id) || !row || !Number.isFinite(row.seen) || now - row.seen < 0 || now - row.seen > 300_000) continue;
    if (isIP(row.address) !== 4 || !validPort(row.port) || !validCapacity(row)) continue;
    nodes.push({ id, address: row.address, port: row.port, weight: row.weight, maxSize: row.maxSize, active: true });
  }
  return { ...fleet, nodes, leaders: nodes.map(node => node.id).sort() };
}

function broadcastAddresses(interfaces, address) {
  const targets = new Set(["255.255.255.255"]);
  for (const row of localIPv4(interfaces).filter(row => row.address === address)) {
    if (isIP(row.netmask) !== 4) continue;
    const mask = row.netmask.split(".").map(Number);
    targets.add(row.address.split(".").map((byte, i) => (Number(byte) | (~mask[i] & 255))).join("."));
  }
  return targets;
}

/** Authenticated LAN discovery with injectable transport, interfaces, timer and clock. */
export async function startDiscovery({ root, fleet, clock = Date.now, interfaces = os.networkInterfaces,
  createSocket = udpSocket, timer = setInterval, clearTimer = clearInterval, warn = console.error }) {
  if (!fleet.secret) throw new Error("fleet secret is required for discovery");
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const nonces = new Map();
  let collisionAt, interval, closed = false;
  const port = fleet.discoveryPort ?? 47913;
  const close = () => { if (closed) return; closed = true; if (interval !== undefined) clearTimer(interval); socket.close(); };
  const announce = () => {
    if (closed) return;
    try {
      const beacon = createBeacon({ fleet, clock, interfaces });
      const data = Buffer.from(JSON.stringify(beacon));
      for (const address of broadcastAddresses(interfaces, beacon.addresses[0])) socket.send(data, port, address, error => {
        if (error) warn(`fleet discovery: ${error.message}`);
      });
    } catch (error) { warn(`fleet discovery: ${error.message}`); }
  };
  socket.on("message", (data, sender) => {
    if (closed || data.length >= 1024) return;
    try {
      const { sig, ...fields } = JSON.parse(data.toString("utf8"));
      if (typeof sig !== "string" || !/^[0-9a-f]{64}$/i.test(sig) ||
        !timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(mac(fields, fleet.secret), "hex"))) return;
      const now = clock();
      if (fields.v !== 1 || !validId(fields.id) || !validPort(fields.port) || !validCapacity(fields) ||
        !Number.isFinite(fields.time) || Math.abs(now - fields.time) > 60_000 ||
        typeof fields.nonce !== "string" || !fields.nonce || fields.nonce.length > 128 ||
        !Array.isArray(fields.addresses) || fields.addresses.length !== 1 || !fields.addresses.every(address => isIP(address) === 4) ||
        !fields.addresses.includes(sender.address)) return;
      for (const [nonce, seen] of nonces) if (now - seen > 120_000) nonces.delete(nonce);
      if (nonces.has(fields.nonce)) return;
      nonces.set(fields.nonce, now);
      if (fields.id === fleet.self) {
        if (!localIPv4(interfaces).some(row => row.address === sender.address) &&
          (collisionAt === undefined || now - collisionAt >= 600_000)) {
          collisionAt = now;
          warn(`fleet name ${fleet.self} is used by ${sender.address}`);
        }
        return;
      }
      const discovered = readDiscovered(root, fleet.secret);
      Object.defineProperty(discovered, fields.id, { enumerable: true, configurable: true, writable: true,
        value: { address: sender.address, port: fields.port, weight: fields.weight, maxSize: fields.maxSize, seen: now } });
      saveDiscovered(root, fleet.secret, discovered);
    } catch (error) {
      // Malformed datagrams are ignored; disk failures remain visible to the operator.
      if (error.code) warn(`fleet discovery: ${error.message}`);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(port, "0.0.0.0", () => { socket.off("error", reject); resolve(); });
    });
    socket.on("error", error => warn(`fleet discovery: ${error.message}`));
    socket.setBroadcast(true);
    announce();
    interval = timer(announce, 15_000);
    return { close };
  } catch (error) { close(); throw error; }
}
