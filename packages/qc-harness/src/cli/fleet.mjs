// A static fleet shares node settings across PCs; only the local self id differs.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../config.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { runGh } from "./gh-run.mjs";
import { gitOut, originOf } from "./git-read.mjs";
import { readState } from "./fleet-state.mjs";
import { nodeStatus, serveNode, startNode, stopNode } from "./fleet-node.mjs";

const SIZES = ["S", "M", "L"];
const USAGE = "usage: qc fleet init --self <id> --nodes <id:weight:size,...> [--secret <hex>] [--addresses <id@host:port,...>] [--force] | next [--repo <o/r>] [--all] | status [--repo <o/r>] | start [--leader] | serve [--leader] | stop";

function validAddress(address) {
  if (typeof address !== "string" || !address || address.trim() !== address || address === "0.0.0.0") return false;
  if (isIP(address) === 6) return new URL(`http://[${address}]/`).hostname !== "[::]";
  return address.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(address);
}

/** The fleet settings live on this PC, outside the repository. */
export function fleetPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.QC_FLEET_FILE) return env.QC_FLEET_FILE;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "qc", "fleet.json");
}

/** Return validated settings with defaults, naming the field for each error. */
export function validateFleet(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fleet must be an object");
  if (!Array.isArray(value.nodes)) throw new Error("nodes must be an array");
  const seen = new Set();
  const nodes = value.nodes.map((node, index) => {
    const field = `nodes[${index}]`;
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error(`${field} must be an object`);
    if (typeof node.id !== "string" || !/^[a-z0-9-]{1,32}$/.test(node.id)) throw new Error(`${field}.id must match ^[a-z0-9-]{1,32}$`);
    if (seen.has(node.id)) throw new Error(`${field}.id is duplicated: ${node.id}`);
    seen.add(node.id);
    if (!Number.isFinite(node.weight) || node.weight <= 0 || node.weight > 100) throw new Error(`${field}.weight must be a number above 0 and at most 100`);
    const maxSize = node.maxSize === undefined ? "L" : node.maxSize;
    if (!SIZES.includes(maxSize)) throw new Error(`${field}.maxSize must be S, M or L`);
    const active = node.active === undefined ? true : node.active;
    if (typeof active !== "boolean") throw new Error(`${field}.active must be a boolean`);
    if (node.address !== undefined && !validAddress(node.address)) throw new Error(`${field}.address must be a host other than 0.0.0.0 or ::`);
    if (node.port !== undefined && (!Number.isInteger(node.port) || node.port < 1024 || node.port > 65535)) throw new Error(`${field}.port must be an integer from 1024 to 65535`);
    return { id: node.id, weight: node.weight, maxSize, active,
      ...(node.address === undefined ? {} : { address: node.address }),
      ...(node.port === undefined ? {} : { port: node.port }) };
  });
  if (typeof value.self !== "string" || !seen.has(value.self)) throw new Error("self must name a node");
  if (value.secret !== undefined && (typeof value.secret !== "string" || value.secret.length < 64 || /[^0-9a-f]/i.test(value.secret))) throw new Error("secret must be hex with at least 64 characters");
  const leaders = value.leaders === undefined ? nodes.map(node => node.id) : value.leaders;
  if (!Array.isArray(leaders) || !leaders.length || leaders.some(id => !seen.has(id)) || new Set(leaders).size !== leaders.length) throw new Error("leaders must be a nonempty list of unique node IDs");
  return { self: value.self, nodes, leaders: [...leaders], ...(value.secret === undefined ? {} : { secret: value.secret }) };
}

/** Weighted rendezvous hashing keeps other owners stable when a PC goes inactive. */
export function ownerOf(repo, number, size, nodes) {
  let owner = null;
  let highest = -Infinity;
  for (const node of nodes) {
    if (node.active === false || SIZES.indexOf(node.maxSize ?? "L") < SIZES.indexOf(size)) continue;
    const hash = createHash("sha256").update(`${repo.toLowerCase()}#${number}:${node.id}`).digest().readBigUInt64BE();
    // Keep u below one even when the integer rounds up during conversion to a double.
    const u = Math.min(1 - Number.EPSILON / 2, Number(hash + 1n) / Number(2n ** 64n + 2n));
    const score = -node.weight / Math.log(u);
    if (score > highest || (score === highest && node.id < owner)) {
      highest = score;
      owner = node.id;
    }
  }
  return owner;
}

function readList(gh, args, cwd, valid) {
  const text = gh(args, { cwd });
  let list;
  try { list = JSON.parse(text); } catch { /* The error below names the failed read. */ }
  if (!Array.isArray(list) || !list.every(valid)) throw new Error(`gh ${args[0]} list returned no readable list`);
  return list;
}

/** Read free open issues and count those already taken by a PR or an origin branch. */
export function freeIssues(repo, cwd, { gh = runGh, git = gitOut, holdLabel = "hold", remote = "origin" } = {}) {
  const issues = readList(gh, ["issue", "list", "--state", "open", "--limit", "500", "--json", "number,labels,createdAt", "--repo", repo], cwd,
    row => Number.isSafeInteger(row?.number) && row.number > 0 && Array.isArray(row.labels) && row.labels.every(label => typeof label?.name === "string") && Number.isFinite(Date.parse(row.createdAt)));
  const prs = readList(gh, ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName,body", "--repo", repo], cwd,
    row => Number.isSafeInteger(row?.number) && typeof row.headRefName === "string" && typeof row.body === "string");
  const branches = git(cwd, "ls-remote", "--heads", remote);
  if (branches === null) throw new Error(`git ls-remote --heads ${remote} failed`);
  const taken = new Set();
  const takeBranch = branch => {
    const match = /^[^/]+\/([0-9]+)-/.exec(branch);
    if (match) taken.add(Number(match[1]));
  };
  for (const pr of prs) {
    takeBranch(pr.headRefName);
    for (const match of pr.body.matchAll(/(?<![\w#])#([0-9]+)(?!\w)/g)) taken.add(Number(match[1]));
  }
  for (const line of branches.split(/\r?\n/)) {
    const match = /^\S+\s+refs\/heads\/(.+)$/.exec(line);
    if (match) takeBranch(match[1]);
  }
  const skip = new Set(["hold", holdLabel.toLowerCase(), "fleet-skip"]);
  const eligible = issues.filter(row => !row.labels.some(label => skip.has(label.name.toLowerCase())));
  const free = eligible.filter(row => !taken.has(row.number)).map(row => ({
    ...row,
    size: row.labels.map(label => /^size:([SML])$/i.exec(label.name)?.[1].toUpperCase()).find(Boolean) ?? "M",
  })).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
  return { free, taken: eligible.filter(row => taken.has(row.number)).length };
}

function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const allowed = verb === "init" ? ["--self", "--nodes", "--secret", "--addresses", "--force"] : verb === "next" ? ["--repo", "--all"] : verb === "status" ? ["--repo"] : ["start", "serve"].includes(verb) ? ["--leader"] : verb === "stop" ? [] : null;
  if (!allowed) throw new Error(USAGE);
  const options = { verb };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!allowed.includes(flag)) throw new Error(`unknown argument ${flag}`);
    if (Object.hasOwn(options, flag)) throw new Error(`duplicate argument ${flag}`);
    if (["--force", "--all", "--leader"].includes(flag)) options[flag] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
      options[flag] = rest[++i];
    }
  }
  if (options["--repo"] && !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(options["--repo"])) throw new Error("--repo needs owner/repository");
  return options;
}

function initialize(options, file, say) {
  if (!options["--self"] || !options["--nodes"]) throw new Error("init needs --self and --nodes");
  const nodes = options["--nodes"].split(",").map(entry => {
    const [id, weight, maxSize, ...extra] = entry.split(":");
    if (extra.length) throw new Error("--nodes needs id:weight:size entries");
    return { id, weight: Number(weight), maxSize };
  });
  if (options["--addresses"]) {
    const addressed = new Set();
    for (const entry of options["--addresses"].split(",")) {
      const match = /^([a-z0-9-]+)@(?:\[([^\]]+)\]|([^@:\s]+)):(\d+)$/.exec(entry);
      if (!match) throw new Error("--addresses needs id@host:port entries (bracket IPv6 hosts)");
      const [, id, ipv6, host, port] = match;
      const node = nodes.find(node => node.id === id);
      if (!node || addressed.has(id)) throw new Error("--addresses must name each known node at most once");
      addressed.add(id);
      Object.assign(node, { address: ipv6 ?? host, port: Number(port) });
    }
  }
  const secret = options["--secret"] ?? randomBytes(32).toString("hex");
  const fleet = validateFleet({ self: options["--self"], nodes, secret });
  mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = openSync(file, options["--force"] ? "w" : "wx", 0o600);
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(fleet, null, 2)}\n`);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`fleet file exists: ${file}; use --force`);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  say(`fleet initialized: ${file}`);
  if (!options["--secret"]) say(`pass the same secret on the other PCs: --secret ${secret}`);
  return 0;
}

/** Fleet verbs return exit codes; injected readers and node operations keep tests local. */
export function runFleet(argv, { cwd = process.cwd(), env = process.env, gh = runGh, git, origin = originOf, say = console.log, warn = console.error, node = {} } = {}) {
  try {
    const options = parseArgs(argv);
    const file = fleetPath(env);
    if (options.verb === "init") return initialize(options, file, say);
    let text;
    try { text = readFileSync(file, "utf8"); } catch (error) {
      if (error.code === "ENOENT") throw new Error(`fleet is off: no ${file}`);
      throw error;
    }
    let value;
    try { value = JSON.parse(text); } catch { throw new Error(`fleet file has invalid JSON: ${file}`); }
    const fleet = validateFleet(value);
    if (["start", "stop", "serve"].includes(options.verb)) {
      return runNodeVerb(options, { root: cwd, fleet, env, gh, git, origin, say, warn, node }).catch(error => { warn(error.message); return 1; });
    }
    const localRepo = origin(cwd);
    const repo = (options["--repo"] ?? localRepo)?.toLowerCase();
    if (!repo) throw new Error("--repo is required when origin has no repository");
    const checkout = checkoutRootOf(cwd);
    if (options.verb === "next" && checkout) {
      const assigned = Object.values(readState(checkout, "assignments")).filter(row => row.repo === repo && row.node === fleet.self);
      if (assigned.length) {
        for (const row of assigned) say(`#${row.issue} epoch=${row.epoch}`);
        return 0;
      }
    }
    const remote = localRepo?.toLowerCase() === repo ? "origin" : `https://github.com/${repo}.git`;
    const config = load(checkout ?? cwd);
    const { free, taken } = freeIssues(repo, cwd, { gh, git, remote, holdLabel: config.merge.holdLabel });
    const owned = free.map(row => ({ ...row, owner: ownerOf(repo, row.number, row.size, fleet.nodes) }));
    if (options.verb === "next") {
      const mine = owned.filter(row => row.owner === fleet.self);
      if (!mine.length) { warn(`no free issue for ${fleet.self}`); return 3; }
      for (const row of options["--all"] ? mine : mine.slice(0, 5)) say(String(row.number));
      return 0;
    }
    for (const node of fleet.nodes.slice(0, 14)) {
      const rows = owned.filter(row => row.owner === node.id);
      say(`${node.id} weight=${node.weight} maxSize=${node.maxSize} active=${node.active} free=${rows.length} ${rows.slice(0, 10).map(row => row.number).join(",")}`.trimEnd());
    }
    const omitted = fleet.nodes.length > 14 ? `; ${fleet.nodes.length - 14} more nodes` : "";
    say(`taken=${taken} unassigned=${owned.filter(row => row.owner === null).length}${omitted}`);
    return nodeStatus({ ...node, root: cwd, fleet })
      .then(status => { say(status); return 0; })
      .catch(error => { warn(error.message); return 1; });
  } catch (error) {
    warn(error.message);
    return 1;
  }
}

async function runNodeVerb(options, { root, fleet, env, gh, git, origin, say, warn, node }) {
  const deps = { gh, git, ...node, root, fleet, env, leader: options["--leader"] === true };
  if (options.verb === "serve") {
    const kitRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const kit = gitOut(kitRoot, "rev-parse", "HEAD")?.trim() || null;
    const holdLabel = load(checkoutRootOf(root) ?? root).merge.holdLabel;
    const server = await serveNode({ ...deps, holdLabel, repo: origin(root) ?? "qc/fleet", kit, warn });
    return new Promise(resolve => server.once("close", () => resolve(0)));
  }
  if (options.verb === "start") {
    const result = await startNode(deps);
    say(`fleet node ${result.already ? "already running" : "started"}: ${fleet.self}`);
  } else {
    const result = await stopNode(deps);
    say(`fleet node ${result.already ? "already stopped" : "stopped"}: ${fleet.self}`);
  }
  return 0;
}
