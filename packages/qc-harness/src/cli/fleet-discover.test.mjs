import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { canonical } from "./fleet-message.mjs";
import { stateDir } from "./fleet-state.mjs";
import { createBeacon, effectiveFleet, readDiscovered, startDiscovery } from "./fleet-discover.mjs";

const secret = "ab".repeat(32);
const now = 1_800_000_000_000;
const interfaces = () => ({ eth0: [{ family: "IPv4", internal: false, address: "192.168.1.10", netmask: "255.255.255.0" }],
  eth1: [{ family: "IPv4", internal: false, address: "10.0.0.2", netmask: "255.255.0.0" }],
  lo: [{ family: "IPv4", internal: true, address: "127.0.0.1", netmask: "255.0.0.0" }],
  v6: [{ family: "IPv6", internal: false, address: "::1" }] });
const fleet = { self: "a", secret, discover: true, nodes: [{ id: "a", port: 8080, weight: 1, maxSize: "L" }] };
const sign = fields => ({ ...fields, sig: createHmac("sha256", Buffer.from(secret, "hex")).update(canonical(fields)).digest("hex") });
const beacon = (changes = {}) => sign({ v: 1, id: "b", port: 8081, addresses: ["192.168.1.20"], weight: 2,
  maxSize: "M", time: now, nonce: "new-nonce", ...changes });

export class FakeSocket extends EventEmitter {
  sent = [];
  closed = false;
  bind(port, host, ready) { this.bound = { port, host }; ready(); }
  setBroadcast(value) { this.broadcast = value; }
  send(data, port, address, callback) { this.sent.push({ data, port, address }); callback?.(); }
  close() { this.closed = true; }
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-discover-"));
  mkdirSync(path.join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

async function listener(t, changes = {}) {
  const root = fixture(t), socket = new FakeSocket(), warnings = [], timers = [], cleared = [];
  let time = now;
  const discovery = await startDiscovery({ root, fleet: { ...fleet, ...changes }, interfaces, clock: () => time,
    createSocket: options => { assert.deepEqual(options, { type: "udp4", reuseAddr: true }); return socket; },
    timer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimer: timer => cleared.push(timer),
    warn: text => warnings.push(text) });
  t.after(() => discovery.close());
  const receive = (message, address = "192.168.1.20") => socket.emit("message", Buffer.from(JSON.stringify(message)), { address });
  return { root, socket, warnings, timers, cleared, discovery, receive, setTime: value => { time = value; } };
}

test("beacons sign canonical data, advertise local IPv4s and stay below 1 KB", () => {
  const value = createBeacon({ fleet, interfaces, clock: () => now });
  const { sig, ...fields } = value;
  assert.deepEqual(Object.keys(fields).sort(), ["v", "id", "port", "addresses", "weight", "maxSize", "time", "nonce"].sort());
  assert.deepEqual(fields.addresses, ["192.168.1.10", "10.0.0.2"]);
  assert.equal(fields.id, "a");
  assert.equal(fields.port, 8080);
  assert.equal(fields.time, now);
  assert.equal(sig, sign(fields).sig);
  assert.notEqual(value.nonce, createBeacon({ fleet, interfaces, clock: () => now }).nonce);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1024);
  const crowded = () => ({ eth0: Array.from({ length: 200 }, (_, i) => ({ family: "IPv4", internal: false,
    address: `10.0.0.${i + 1}`, netmask: "255.255.255.0" })) });
  assert.ok(Buffer.byteLength(JSON.stringify(createBeacon({ fleet, interfaces: crowded, clock: () => now }))) < 1024);
});

test("discovery binds UDP, broadcasts at start and every 15 seconds, and saves a good beacon", async t => {
  const f = await listener(t);
  assert.deepEqual(f.socket.bound, { port: 47913, host: "0.0.0.0" });
  assert.equal(f.socket.broadcast, true);
  assert.deepEqual(f.socket.sent.map(row => row.address), ["255.255.255.255", "192.168.1.255", "10.0.255.255"]);
  assert.ok(f.socket.sent.every(row => row.port === 47913 && row.data.length < 1024));
  assert.equal(f.timers[0].ms, 15_000);
  const first = JSON.parse(f.socket.sent[0].data).nonce;
  f.timers[0].fn();
  assert.equal(f.socket.sent.length, 6);
  assert.notEqual(JSON.parse(f.socket.sent[3].data).nonce, first);
  f.receive(beacon());
  const saved = { b: { address: "192.168.1.20", port: 8081, weight: 2, maxSize: "M", seen: now } };
  assert.deepEqual(readDiscovered(f.root), saved);
  assert.deepEqual(JSON.parse(readFileSync(path.join(stateDir(f.root), "discovered.json"), "utf8")), saved);
  f.discovery.close();
  assert.equal(f.socket.closed, true);
  assert.deepEqual(f.cleared, f.timers);
});

test("discovery rejects bad MAC, old/future time, address mismatch and malformed signed fields", async t => {
  const f = await listener(t, { discoveryPort: 49000 });
  assert.equal(f.socket.bound.port, 49000);
  const invalid = [
    { ...beacon(), sig: "00".repeat(32) }, { ...beacon(), sig: "bad" },
    beacon({ time: now - 60_001 }), beacon({ time: now + 60_001 }), beacon({ time: "bad" }),
    beacon({ addresses: ["192.168.1.99"] }), beacon({ addresses: "192.168.1.20" }),
    ...["A", "", "a".repeat(33), "a/b"].map(id => beacon({ id })),
    ...[1023, 65536, 8080.5, "8080"].map(port => beacon({ port })),
    ...[0, -1, 101, "2"].map(weight => beacon({ weight })),
    beacon({ maxSize: "XL" }), beacon({ v: 2 }), beacon({ nonce: "" }),
    beacon({ extra: "x".repeat(1024) }),
  ];
  for (const value of invalid) f.receive(value);
  f.socket.emit("message", Buffer.from("{"), { address: "192.168.1.20" });
  assert.deepEqual(readDiscovered(f.root), {});
});

test("a nonce is rejected for 120 seconds and old entries can be received with a fresh nonce", async t => {
  const f = await listener(t);
  f.receive(beacon());
  f.setTime(now + 1000);
  f.receive(beacon());
  assert.equal(readDiscovered(f.root).b.seen, now);
  f.receive(beacon({ time: now + 1000, port: 9000 }));
  assert.equal(readDiscovered(f.root).b.port, 8081);
  f.setTime(now + 120_001);
  f.receive(beacon({ time: now + 120_001 }));
  assert.equal(readDiscovered(f.root).b.seen, now + 120_001);
});

test("name collisions are dropped and reported at most once per ten minutes", async t => {
  const f = await listener(t);
  f.receive(beacon({ id: "a" }));
  f.setTime(now + 60_000);
  f.receive(beacon({ id: "a", nonce: "another", time: now + 60_000 }));
  assert.deepEqual(f.warnings, ["fleet name a is used by 192.168.1.20"]);
  f.setTime(now + 600_000);
  f.receive(beacon({ id: "a", nonce: "third", time: now + 600_000 }));
  assert.equal(f.warnings.length, 2);
  f.receive(beacon({ id: "a", nonce: "local", time: now + 600_000, addresses: ["192.168.1.10"] }), "192.168.1.10");
  assert.equal(f.warnings.length, 2);
  assert.deepEqual(readDiscovered(f.root), {});
});

test("effectiveFleet expires discoveries after 300 seconds, keeps configured nodes and sorts leaders", () => {
  const staticFleet = { ...fleet, discover: false };
  assert.equal(effectiveFleet(staticFleet, {}, now, interfaces), staticFleet);
  const configured = { ...fleet, leaders: ["z"], nodes: [...fleet.nodes, { id: "z", address: "fixed", port: 9000 }] };
  const discovered = {
    b: { address: "192.168.1.20", port: 8081, weight: 2, maxSize: "M", seen: now - 299_999 },
    c: { address: "192.168.1.21", port: 8082, weight: 1, maxSize: "S", seen: now - 300_000 },
    old: { address: "192.168.1.22", port: 8083, weight: 1, maxSize: "L", seen: now - 300_001 },
    z: { address: "changed", port: 1234, weight: 10, maxSize: "S", seen: now },
  };
  const current = effectiveFleet(configured, discovered, now, interfaces);
  assert.equal(current.nodes[0].address, "192.168.1.10");
  assert.equal(current.nodes[1], configured.nodes[1]);
  assert.deepEqual(current.leaders, ["a", "b", "c", "z"]);
  assert.deepEqual(current.nodes.find(node => node.id === "b"), { id: "b", address: "192.168.1.20", port: 8081, weight: 2, maxSize: "M", active: true });
  assert.deepEqual(effectiveFleet(configured, discovered, now + 300_001, interfaces).leaders, ["a", "z"]);
  assert.equal(configured.nodes[0].address, undefined);
});
