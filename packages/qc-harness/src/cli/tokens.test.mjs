import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RATES, costsOf, summarizeSession } from "./tokens.mjs";

const MINUTE = 60_000;
const req = (id, minute, read, write, { input = 2, model = "m", w1h = 0 } = {}) => ({
  id,
  model,
  at: minute * MINUTE,
  usage: {
    input_tokens: input,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cache_creation: { ephemeral_5m_input_tokens: write - w1h, ephemeral_1h_input_tokens: w1h },
    output_tokens: 5,
  },
});

test("with no gap past five minutes, the one-hour lifetime only raises the write price", () => {
  const { cost, cost1h, gapMisses } = costsOf([req("a", 0, 0, 1000), req("b", 1, 1000, 100)]);
  assert.equal(cost, 1000 * 1.25 + 2 + 1000 * 0.1 + 100 * 1.25 + 2);
  assert.equal(cost1h, 1000 * 2 + 2 + 1000 * 0.1 + 100 * 2 + 2);
  assert.equal(gapMisses, 0);
});

test("a miss after a gap of five minutes to an hour becomes a read of the old context at one hour", () => {
  const { cost, cost1h, gapMisses } = costsOf([req("a", 0, 0, 1000), req("b", 10, 0, 1100)]);
  assert.equal(gapMisses, 1);
  assert.equal(cost, 1000 * 1.25 + 2 + 1100 * 1.25 + 2);
  // The second request re-sent 1,002 tokens it had sent before; only its 100 new ones are written.
  assert.equal(cost1h, 1000 * 2 + 2 + (1100 - 100) * 0.1 + 100 * 2 + 2);
  assert.ok(cost1h < cost);
});

test("a gap past an hour misses at either lifetime", () => {
  const { cost1h, gapMisses } = costsOf([req("a", 0, 0, 1000), req("b", 90, 0, 1100)]);
  assert.equal(gapMisses, 1);
  assert.equal(cost1h, 1000 * 2 + 2 + 1100 * 2 + 2);
});

test("an observed one-hour write is priced as one", () => {
  const { cost } = costsOf([req("a", 0, 0, 1000, { w1h: 1000 })]);
  assert.equal(cost, 1000 * 2 + 2);
});

test("summarizeSession adds each type's agents, and lists main first, then by tokens read", () => {
  const { types, total } = summarizeSession({
    main: [req("m1", 0, 0, 500), req("m2", 1, 500, 50)],
    agents: [
      { type: "impl", requests: [req("i1", 0, 0, 1000), req("i2", 1, 1000, 100), req("i3", 2, 1100, 100)] },
      { type: "impl", requests: [req("j1", 3, 800, 200), req("j2", 4, 1000, 100)] },
      { type: "rev", requests: [req("r1", 0, 0, 300)] },
    ],
  });
  assert.deepEqual(types.map((stats) => stats.type), ["main", "impl", "rev"]);
  const impl = types[1];
  assert.equal(impl.agents, 2);
  assert.equal(impl.calls, 5);
  assert.equal(impl.read, 0 + 1000 + 1100 + 800 + 1000);
  assert.equal(impl.write5m, 1000 + 100 + 100 + 200 + 100);
  assert.equal(impl.maxContext, 1100 + 100 + 2);
  assert.equal(impl.hitRate, impl.read / (impl.read + impl.write5m + impl.write1h + impl.input));
  assert.equal(impl.firstMedian, 1002);
  assert.equal(total.calls, 2 + 5 + 1);
  assert.equal(total.read, types.reduce((sum, stats) => sum + stats.read, 0));
});

test("a first call that missed a shared prefix warmed 5 to 60 minutes before reads it at one hour", () => {
  const agents = [
    { type: "rev", requests: [req("a", 0, 0, 1000)] },
    { type: "rev", requests: [req("b", 2, 800, 200)] },
    { type: "rev", requests: [req("c", 20, 0, 1000)] },
  ];
  const [stats] = summarizeSession({ agents }).types;
  const plain = agents.reduce((sum, agent) => sum + costsOf(agent.requests).cost1h, 0);
  assert.equal(stats.cost1h, plain - 800 * (RATES.write1h - RATES.read));
  assert.equal(stats.prefixes, 1);
});

test("two first-call prefixes of one model in one session count as two", () => {
  const agents = [
    { type: "rev", requests: [req("a", 0, 800, 200)] },
    { type: "rev", requests: [req("b", 1, 900, 200)] },
    { type: "rev", requests: [req("c", 2, 700, 200, { model: "other" })] },
  ];
  assert.equal(summarizeSession({ agents }).types[0].prefixes, 2);
});

test("an empty session sums to zero without dividing by zero", () => {
  const { types, total } = summarizeSession({ main: [], agents: [] });
  assert.deepEqual(types, []);
  assert.equal(total.hitRate, 0);
  assert.equal(total.whatIf1h, 0);
});
