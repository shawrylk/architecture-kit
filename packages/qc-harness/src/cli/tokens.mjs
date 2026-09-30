// `qc tokens`: what one session read and wrote, per agent type, from its transcripts. It also prices the
// same requests at the one-hour cache lifetime, at API list prices, to show which lifetime fits.

import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentTypeOf, contextOf, readRequests } from "./transcript-usage.mjs";

export const RATES = { read: 0.1, write5m: 1.25, write1h: 2 };
const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
export const MAIN = "main";

const readOf = (usage) => usage.cache_read_input_tokens ?? 0;
const writeOf = (usage) => usage.cache_creation_input_tokens ?? 0;
const write1hOf = (usage) => usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
const inputOf = (usage) => usage.input_tokens ?? 0;

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The observed cost of one agent's requests, the cost at a one-hour lifetime, and its gap misses, in base-input units. */
export function costsOf(requests, rates = RATES) {
  let cost = 0;
  let cost1h = 0;
  let gapMisses = 0;
  requests.forEach((request, index) => {
    const { usage } = request;
    const read = readOf(usage);
    const write = writeOf(usage);
    const w1h = write1hOf(usage);
    const input = inputOf(usage);
    cost += read * rates.read + (write - w1h) * rates.write5m + w1h * rates.write1h + input;
    const previous = requests[index - 1];
    const gap = previous && request.at !== null && previous.at !== null ? request.at - previous.at : 0;
    const missed = previous !== undefined && gap > FIVE_MINUTES && write > read;
    if (missed) gapMisses += 1;
    if (missed && gap <= ONE_HOUR) {
      const fresh = Math.max(0, contextOf(usage) - contextOf(previous.usage));
      cost1h += (read + write - fresh) * rates.read + fresh * rates.write1h + input;
    } else {
      cost1h += read * rates.read + write * rates.write1h + input;
    }
  });
  return { cost, cost1h, gapMisses };
}

const emptyStats = (type) => ({
  type, agents: 0, calls: 0, read: 0, write5m: 0, write1h: 0, input: 0, output: 0,
  contextSum: 0, maxContext: 0, firsts: [], gapMisses: 0, cost: 0, cost1h: 0,
});

function addAgent(stats, requests, rates) {
  if (requests.length === 0) return;
  stats.agents += 1;
  stats.calls += requests.length;
  for (const { usage } of requests) {
    stats.read += readOf(usage);
    stats.write1h += write1hOf(usage);
    stats.write5m += writeOf(usage) - write1hOf(usage);
    stats.input += inputOf(usage);
    stats.output += usage.output_tokens ?? 0;
    const context = contextOf(usage);
    stats.contextSum += context;
    stats.maxContext = Math.max(stats.maxContext, context);
  }
  const [first] = requests;
  stats.firsts.push({ at: first.at, model: first.model ?? "", read: readOf(first.usage), context: contextOf(first.usage) });
  const costs = costsOf(requests, rates);
  stats.cost += costs.cost;
  stats.cost1h += costs.cost1h;
  stats.gapMisses += costs.gapMisses;
}

function byModel(firsts) {
  const groups = new Map();
  for (const first of firsts) groups.set(first.model, [...(groups.get(first.model) ?? []), first]);
  return [...groups.values()];
}

/** The one-hour saving on first calls that found no shared prefix, though one of the same model warmed it 5 to 60 minutes before. */
function sharedPrefixCredit(firsts, rates) {
  let credit = 0;
  for (const group of byModel(firsts)) {
    const shared = median(group.map((first) => first.read).filter((read) => read > 0));
    if (shared === 0) continue;
    const timed = group.filter((first) => first.at !== null).sort((a, b) => a.at - b.at);
    timed.forEach((first, index) => {
      const gap = index > 0 ? first.at - timed[index - 1].at : 0;
      if (index > 0 && first.read === 0 && gap > FIVE_MINUTES && gap <= ONE_HOUR) credit += shared * (rates.write1h - rates.read);
    });
  }
  return credit;
}

/** The most distinct warm first-call reads one model of the type saw: more than one means its prefix changed. */
const prefixesOf = (firsts) =>
  Math.max(0, ...byModel(firsts).map((group) => new Set(group.map((first) => first.read).filter((read) => read > 0)).size));

function finish(stats, rates, credit = sharedPrefixCredit(stats.firsts, rates)) {
  const sent = stats.read + stats.write5m + stats.write1h + stats.input;
  const cost1h = stats.cost1h - credit;
  const { firsts, ...rest } = stats;
  return {
    ...rest,
    hitRate: sent === 0 ? 0 : stats.read / sent,
    avgContext: stats.calls === 0 ? 0 : Math.round(stats.contextSum / stats.calls),
    firstMedian: median(firsts.map((first) => first.context)),
    prefixes: prefixesOf(firsts),
    cost1h,
    whatIf1h: stats.cost === 0 ? 0 : (cost1h - stats.cost) / stats.cost,
  };
}

const SUMMED = ["agents", "calls", "read", "write5m", "write1h", "input", "output", "contextSum", "gapMisses", "cost", "cost1h"];

/** Per-type statistics of one session, `main` first and then by tokens read, and their total. */
export function summarizeSession({ main = [], agents = [] }, rates = RATES) {
  const byType = new Map();
  const statsOf = (type) => byType.get(type) ?? byType.set(type, emptyStats(type)).get(type);
  if (main.length > 0) addAgent(statsOf(MAIN), main, rates);
  for (const agent of agents) addAgent(statsOf(agent.type), agent.requests, rates);
  const finished = [...byType.values()].map((stats) => finish(stats, rates));
  const types = [
    ...finished.filter((stats) => stats.type === MAIN),
    ...finished.filter((stats) => stats.type !== MAIN).sort((a, b) => b.read - a.read),
  ];
  const sum = emptyStats("total");
  for (const stats of types) {
    for (const key of SUMMED) sum[key] += stats[key];
    sum.maxContext = Math.max(sum.maxContext, stats.maxContext);
  }
  // The types' own credits are already in their cost1h, so the total takes none of its own.
  return { types, total: finish(sum, rates, 0) };
}

const UNKNOWN = "unknown";

/** The folder name Claude Code gives a project: its path, with each character outside letters and digits a dash. */
export const projectKeyOf = (dir) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, "-");

export const claudeDirOf = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

function listOf(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function newestSession(projectDir) {
  let newest = null;
  for (const name of listOf(projectDir).filter((file) => file.endsWith(".jsonl"))) {
    const at = statSync(path.join(projectDir, name)).mtimeMs;
    if (!newest || at > newest.at) newest = { id: name.slice(0, -".jsonl".length), at };
  }
  return newest?.id ?? null;
}

/** The transcripts of one session: `session`, or the newest one of the project. @returns null when there is none */
export function sessionFiles({ claudeDir, project, session = null }) {
  const projectDir = path.join(claudeDir, "projects", projectKeyOf(project));
  const id = session ?? newestSession(projectDir);
  if (!id) return null;
  const main = path.join(projectDir, `${id}.jsonl`);
  const subagents = path.join(projectDir, id, "subagents");
  const agents = listOf(subagents).filter((file) => /^agent-.+\.jsonl$/.test(file)).map((file) => path.join(subagents, file));
  const hasMain = listOf(projectDir).includes(`${id}.jsonl`);
  if (!hasMain && agents.length === 0) return null;
  return { id, main: hasMain ? main : null, agents };
}

function optionsOf(args) {
  const options = { session: null, project: null, claudeDir: null, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--session") options.session = args[++index] ?? null;
    else if (arg === "--project") options.project = args[++index] ?? null;
    else if (arg === "--claude-dir") options.claudeDir = args[++index] ?? null;
  }
  return options;
}

const amount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));
const percent = (x) => `${(x * 100).toFixed(1)}%`;
const signed = (x) => `${x > 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const COLUMNS = [
  ["type", 34, (s) => s.type],
  ["agents", 6, (s) => String(s.agents)],
  ["calls", 6, (s) => String(s.calls)],
  ["read", 7, (s) => amount(s.read)],
  ["w5m", 7, (s) => amount(s.write5m)],
  ["w1h", 7, (s) => amount(s.write1h)],
  ["input", 6, (s) => amount(s.input)],
  ["output", 6, (s) => amount(s.output)],
  ["hit", 6, (s) => percent(s.hitRate)],
  ["avgctx", 6, (s) => amount(s.avgContext)],
  ["first", 6, (s) => (s.type === "total" ? "-" : amount(s.firstMedian))],
  ["maxctx", 6, (s) => amount(s.maxContext)],
  ["gapmiss", 7, (s) => String(s.gapMisses)],
  ["prefix", 6, (s) => (s.type === "total" ? "-" : String(s.prefixes))],
  ["1h", 7, (s) => signed(s.whatIf1h)],
];
const row = (cells) => cells.map((cell, index) => (index === 0 ? cell.padEnd(COLUMNS[0][1]) : cell.padStart(COLUMNS[index][1]))).join(" ");

const FOOTER = [
  `Rates, in base-input units: read ${RATES.read}, 5m write ${RATES.write5m}, 1h write ${RATES.write1h}. These are API list prices; a subscription's usage limit may weigh them otherwise.`,
  "1h: the cost change had every write used the one-hour lifetime. A negative value favors `subagentPromptCacheTtl: \"1h\"` in settings for this kind of session.",
  "gapmiss: calls after a gap over five minutes that wrote more than they read. prefix: distinct warm first-call reads per model; more than 1 means the type's prefix changed.",
];

/** `qc tokens [--session <id>] [--project <dir>] [--claude-dir <dir>] [--json]`. @returns the exit code */
export function runTokens(config, args = [], out = console.log, err = console.error) {
  const options = optionsOf(args);
  const project = options.project ?? config.root ?? process.cwd();
  const files = sessionFiles({ claudeDir: options.claudeDir ?? claudeDirOf(), project, session: options.session });
  if (!files) {
    err(`qc tokens: no session transcript for ${project} under ${options.claudeDir ?? claudeDirOf()}.`);
    return 1;
  }
  const report = summarizeSession({
    main: files.main ? readRequests(files.main) : [],
    agents: files.agents.map((file) => ({ type: agentTypeOf(file) ?? UNKNOWN, requests: readRequests(file) })),
  });
  if (options.json) {
    out(JSON.stringify({ session: files.id, ...report }, null, 2));
    return 0;
  }
  out(`qc tokens  session ${files.id}`);
  out(row(COLUMNS.map(([name]) => name)));
  for (const stats of [...report.types, report.total]) out(row(COLUMNS.map(([, , cell]) => cell(stats))));
  for (const text of FOOTER) out(text);
  return 0;
}
