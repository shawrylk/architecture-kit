// Fleets share a secret and either discover LAN peers or use a static node list.
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
import { sendPushed, validPlatformBranch } from "./fleet-platform.mjs";
import { TALK_VERBS, parseTalkArgs, runTalk } from "./fleet-talk.mjs";
import { highestTerm, latestLeader, readState, writeState } from "./fleet-state.mjs";
import { confirmLeader, nodeStatus, serveNode, startNode, stopNode } from "./fleet-node.mjs";
import { createKey, validateKey, pairingDecision, readPairing } from "./fleet-pair.mjs";
import { effectiveFleet, readDiscovered } from "./fleet-discover.mjs";

const SIZES = ["S", "M", "L"];
const USAGE = "usage: qc fleet init [--self <id>] [--nodes <id:weight:size,...>] [--port <port>] [--secret <hex>] [--addresses <id@host:port,...>] [--force] | next [--repo <o/r>] [--all] | status [--repo <o/r>] | plan <issue> --file <path> | ask <issue> --file <path> | say <node-id|leader> --file <path> | approve <message-id> [--changes] [--file <path>] | answer <message-id> --file <path> | show <message-id> | start [--leader] | serve [--leader] | stop | allow <code> | deny <code> | accept <code> | confirm-leader | progress <issue> --step plan|code|review|merge [--branch <b>] [--head <sha40>] | owns <issue> | pushed <issue> --branch <b> --head <sha40>";

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
  if (value.discover !== undefined && typeof value.discover !== "boolean") throw new Error("discover must be a boolean");
  if (value.discoveryPort !== undefined && (!Number.isInteger(value.discoveryPort) || value.discoveryPort < 1024 || value.discoveryPort > 65535)) throw new Error("discoveryPort must be an integer from 1024 to 65535");
  const key = value.key === undefined ? undefined : validateKey(value.key);
  return { ...(key === undefined ? {} : { key }), self: value.self, nodes, leaders: [...leaders], ...(value.secret === undefined ? {} : { secret: value.secret }),
    ...(value.discover === undefined ? {} : { discover: value.discover }),
    ...(value.discoveryPort === undefined && value.discover === undefined ? {} : { discoveryPort: value.discoveryPort ?? 47913 }) };
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

/** Read this node's open work without changing the serve loop's saved snapshot. */
export function readOpenAssignments({ root, fleet, repo, gh = runGh, warn = () => {} }) {
  const assignments = readState(root, "assignments");
  const held = Object.entries(assignments).filter(([, row]) => row.repo === repo && row.node === fleet.self);
  if (!held.length) return [];
  let open;
  try {
    open = new Set(readList(gh, ["issue", "list", "--state", "open", "--limit", "500", "--json", "number", "--repo", repo], root,
      row => Number.isSafeInteger(row?.number) && row.number > 0).map(row => row.number));
  } catch (error) {
    warn(`fleet node: ${error.message}`);
    return held.map(([, row]) => row);
  }
  return held.filter(([, row]) => open.has(row.issue)).map(([, row]) => row);
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
  const [verb, ...args] = argv;
  if (["allow", "deny", "accept"].includes(verb)) {
    if (args.length !== 1 || !/^\d{6}$/.test(args[0])) throw new Error(`${verb} needs a 6-digit code`);
    return { verb, code: args[0] };
  }
  if (TALK_VERBS.includes(verb)) return parseTalkArgs(verb, args);
  const hasIssue = ["progress", "owns", "pushed"].includes(verb);
  const rest = hasIssue ? args.slice(1) : args;
  const allowed = verb === "init" ? ["--self", "--nodes", "--port", "--secret", "--addresses", "--force"] : verb === "next" ? ["--repo", "--all"] : verb === "status" ? ["--repo"] : ["start", "serve"].includes(verb) ? ["--leader"] : verb === "pushed" ? ["--branch", "--head"] : verb === "progress" ? ["--step", "--branch", "--head"] : ["stop", "owns", "confirm-leader"].includes(verb) ? [] : null;
  if (!allowed) throw new Error(USAGE);
  const options = { verb };
  if (hasIssue) {
    if (!/^[1-9][0-9]*$/.test(args[0] ?? "") || !Number.isSafeInteger(Number(args[0]))) throw new Error(`${verb} needs a positive issue number`);
    options.issue = Number(args[0]);
  }
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
  if (verb === "pushed" && (!validPlatformBranch(options["--branch"]) || !/^[0-9a-f]{40}$/i.test(options["--head"] ?? ""))) throw new Error("pushed needs --branch and a 40-character --head");
  if (verb === "progress") {
    if (!["plan", "code", "review", "merge"].includes(options["--step"])) throw new Error("--step needs plan, code, review or merge");
    if (options["--head"] !== undefined && !/^[0-9a-f]{40}$/i.test(options["--head"])) throw new Error("--head needs a 40-character SHA");
    const branch = options["--branch"];
    if (branch !== undefined && (!branch || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(branch) || /(^[-/.]|[/.]$|\.\.|@\{|\/\/|\.lock(?:\/|$)|\/\.)/.test(branch) || branch === "@")) throw new Error("--branch needs a valid branch name");
  }
  return options;
}

function initialize(options, file, say) {
  if (options["--nodes"] !== undefined && options["--self"] === undefined) throw new Error("init needs --self with --nodes");
  const self = options["--self"] ?? randomBytes(2).toString("hex");
  const port = Number(options["--port"] ?? 8080);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be an integer from 1024 to 65535");
  const nodes = options["--nodes"] === undefined ? [{ id: self, weight: 1, maxSize: "L", port }] : options["--nodes"].split(",").map(entry => {
    const [id, weight, maxSize, ...extra] = entry.split(":");
    if (extra.length) throw new Error("--nodes needs id:weight:size entries");
    return { id, weight: Number(weight), maxSize };
  });
  if (options["--nodes"] !== undefined && options["--port"] !== undefined) {
    const local = nodes.find(node => node.id === self);
    if (local) local.port = port;
  }
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
  const secret = options["--secret"] ?? (options["--nodes"] === undefined ? undefined : randomBytes(32).toString("hex"));
  const fleet = validateFleet({ self, nodes, secret, key: createKey(), ...(options["--nodes"] === undefined ? { discover: true } : {}) });
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
  if (options["--nodes"] !== undefined) say(`fleet initialized: ${file}`);
  say(`fleet name: ${self}`);
  if (options["--nodes"] !== undefined && !options["--secret"]) say(`run on the other PCs: npx architecture-harness fleet init --secret ${secret}`);
  return 0;
}

export function saveFleet(file, value) {
  let fd;
  try {
    fd = openSync(file, "w", 0o600);
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally { if (fd !== undefined) closeSync(fd); }
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
    const configuredFleet = validateFleet(value);
    if (["start", "serve"].includes(options.verb)) {
      let changed = false;
      if (!configuredFleet.key) { configuredFleet.key = createKey(); changed = true; }
      if (configuredFleet.discover && !configuredFleet.secret && options["--leader"]) {
        configuredFleet.secret = randomBytes(32).toString("hex");
        changed = true;
      }
      if (changed) saveFleet(file, { ...value, ...configuredFleet });
    }
    const fleet = effectiveFleet(configuredFleet, configuredFleet.discover ? readDiscovered(cwd, configuredFleet.secret) : {}, node.clock?.() ?? Date.now(), node.interfaces);
    if (["allow", "deny", "accept"].includes(options.verb)) {
      const joiner = !fleet.secret, leader = Boolean(fleet.secret && readState(cwd, "node").leader);
      if (options.verb === "accept" ? !joiner : options.verb === "allow" ? !leader : !joiner && !leader) throw new Error("pairing command is not available for this role");
      pairingDecision(cwd, options.verb, options.code, node.clock?.() ?? Date.now(), { joiner });
      say(`${options.verb} ${options.code}`);
      return 0;
    }
    if (options.verb === "status") {
      say(`name=${fleet.self} discover=${fleet.discover ? "on" : "off"}`);
      const now = node.clock?.() ?? Date.now(), pairing = readPairing(cwd);
      const live = row => Number.isFinite(row.seen) && now >= row.seen && now - row.seen <= 600_000;
      if (fleet.secret && readState(cwd, "node").leader) {
        for (const [id, row] of Object.entries(pairing.requests)) if (live(row) && /^\d{6}$/.test(row.code ?? "")) say(`join? ${id} code=${row.code} host=${row.hostname} address=${row.address}`);
      } else if (!fleet.secret) {
        for (const [id, row] of Object.entries(pairing.offers)) if (live(row)) say(`joining ${id} code=${row.code}`);
      }
      if ((fleet.discover && !fleet.secret) || (!origin(cwd) && !options["--repo"])) return 0;
    }
    if (["start", "stop", "serve"].includes(options.verb)) {
      return runNodeVerb(options, { root: cwd, fleet, configuredFleet, env, gh, git, origin, say, warn, node }).catch(error => { warn(error.message); return 1; });
    }
    if (options.verb === "confirm-leader") {
      const term = confirmLeader({ ...node, root: cwd, fleet });
      say(`Leader ${fleet.self} term ${term}`);
      return 0;
    }
    const localRepo = origin(cwd);
    const repo = (options["--repo"] ?? localRepo)?.toLowerCase();
    if (!repo) throw new Error("--repo is required when origin has no repository");
    if (TALK_VERBS.includes(options.verb)) {
      return runTalk(options, { root: cwd, fleet, repo, gh, say, node }).catch(error => { warn(error.message); return 1; });
    }
    const checkout = checkoutRootOf(cwd);
    if (["progress", "owns", "pushed"].includes(options.verb)) {
      if (!checkout) throw new Error("fleet work needs a git checkout");
      const key = `${repo}#${options.issue}`, row = readState(checkout, "assignments")[key];
      if (!row || row.node !== fleet.self) throw new Error(`no own assignment for #${options.issue}`);
      if (["owns", "pushed"].includes(options.verb)) {
        const leader = latestLeader(readState(checkout, "peers"), highestTerm(checkout));
        if (!leader) throw new Error("no Leader heartbeat yet");
        const listed = leader.assigned?.find(item => item.repo === repo && item.issue === options.issue);
        if (!listed) throw new Error(`Leader does not list an assignment for #${options.issue}`);
        if (listed.epoch !== row.epoch) throw new Error(`#${options.issue} epoch ${row.epoch} differs from Leader epoch ${listed.epoch}`);
        if (options.verb === "pushed") return sendPushed({ root: checkout, fleet, repo, issue: options.issue, epoch: row.epoch,
          branch: options["--branch"], head: options["--head"], node, say }).catch(error => { warn(error.message); return 1; });
        return 0;
      }
      const work = readState(checkout, "work"), saved = work[key]?.epoch === row.epoch ? work[key] : {};
      work[key] = { repo, issue: options.issue, epoch: row.epoch, step: options["--step"],
        branch: options["--branch"] ?? saved.branch ?? null, head: options["--head"] ?? saved.head ?? null };
      writeState(checkout, "work", work);
      say(`#${options.issue} epoch=${row.epoch} step=${options["--step"]}`);
      return 0;
    }
    if (options.verb === "next" && checkout) {
      const assigned = readOpenAssignments({ root: checkout, fleet, repo, gh });
      if (assigned.length) {
        const plans = readState(checkout, "plans");
        for (const row of assigned) {
          const plan = plans[`${repo}#${row.issue}`]?.body;
          const decision = plan?.epoch === row.epoch ? plan.approved ? " plan approved" : " plan needs changes" : "";
          say(`#${row.issue} epoch=${row.epoch}${row.branch || row.head ? ` from ${row.branch ?? "?"}@${row.head ?? "?"}` : ""}${decision}`);
        }
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
      .then(status => { for (const line of status.split("\n")) say(line); return 0; })
      .catch(error => { warn(error.message); return 1; });
  } catch (error) {
    warn(error.message);
    return 1;
  }
}

async function runNodeVerb(options, { root, fleet, configuredFleet, env, gh, git, origin, say, warn, node }) {
  const deps = { gh, git, ...node, root, fleet, configuredFleet, env, fleetFile: fleetPath(env), leader: options["--leader"] === true };
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
