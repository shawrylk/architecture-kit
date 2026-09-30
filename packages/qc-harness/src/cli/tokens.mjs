// `qc tokens`: what one session read and wrote, per agent type, from its transcripts. It also prices the
// same requests at the one-hour cache lifetime, at API list prices, to show which lifetime fits.

import { contextOf } from "./transcript-usage.mjs";

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
