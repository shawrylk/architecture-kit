import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discover, pairStates, catalogCoverage, scaffoldEntry } from "../screens/discovery.mjs";
import { targetSession } from "../screens/stack-auth.mjs";

/** Trigger: discovery artifacts drive pairing, coverage, and catalog scaffolds. */
export async function runDiscovery(command, map, values, { chromium, say }) {
  const out = path.resolve(values.out ?? ".");
  mkdirSync(out, { recursive: true });
  const read = name => JSON.parse(readFileSync(path.join(out, `discovered-${name}.json`), "utf8"));
  if (command === "discover") {
    const target = map.targets[values.target];
    if (!target) throw new Error("Choose --target from the map");
    const timeout = Number(values.timeout ?? 15000);
    const depth = Number(values.depth ?? 4);
    const maxStates = Number(values["max-states"] ?? 500);
    if (!Number.isInteger(depth) || depth < 0 || !Number.isInteger(maxStates) || maxStates < 1) throw new Error("Invalid depth or state bound");
    const session = await targetSession(chromium, target, { timeout, signInTimeout: Number(values["sign-in-timeout"] ?? 180000), targetName: values.target, say });
    try {
      const routes = [...new Map(map.screens.flatMap(screen => screen.targets[values.target]?.path ? [screen.targets[values.target].path] : []).map(route => [route, route])).values()];
      const result = await discover(session, { ...target, routes: target.routes ?? routes }, { out, targetName: values.target, widths: map.widths, depth, timeout, maxStates, allowWrites: values["allow-writes"], say });
      say(JSON.stringify({ target: result.target, states: result.states.length, counts: result.counts, errors: result.errors.length, unresolvedRoutes: result.unresolvedRoutes, blockedRequests: result.blockedRequests, complete: result.complete }));
      return result.complete ? 0 : 1;
    } finally { await session.close(); }
  }
  if (command === "pair") {
    const names = values.targets?.split(",");
    if (names?.length !== 2) throw new Error("pair requires --targets <legacy,mono>");
    const pairs = pairStates(read(names[0]).states, read(names[1]).states);
    const result = { targets: names, pairs, counts: Object.fromEntries(["paired", "legacy-only", "mono-only"].map(kind => [kind, pairs.filter(item => item.kind === kind).length])) };
    writeFileSync(path.join(out, "pairs.json"), JSON.stringify(result, null, 2));
    say(JSON.stringify(result.counts));
    return 0;
  }
  const names = values.target ? [values.target] : readdirSync(out).filter(name => /^discovered-.+\.json$/.test(name)).map(name => name.slice(11, -5));
  if (!names.length) throw new Error("No discoveries found");
  if (command === "coverage") {
    const rows = names.map(name => {
      const discovered = read(name);
      return { target: name, complete: discovered.complete, ...catalogCoverage(discovered.states, map.screens, map.excluded, name) };
    });
    writeFileSync(path.join(out, "coverage.json"), JSON.stringify(rows, null, 2));
    for (const row of rows) say(JSON.stringify({ target: row.target, complete: row.complete, covered: row.covered, total: row.total, missing: row.missing.length }));
    return rows.some(row => !row.complete || row.missing.length) ? 1 : 0;
  }
  const directory = path.resolve(values["catalog-out"] ?? path.join(out, "catalog"));
  mkdirSync(directory, { recursive: true });
  let written = 0;
  for (const name of names) {
    const family = map.targets[name]?.family ?? name.split("-")[0];
    for (const state of read(name).states) {
      const file = path.join(directory, `${name}-${state.id}.ts`);
      if (existsSync(file)) continue;
      writeFileSync(file, scaffoldEntry(state, family), { flag: "wx" });
      written++;
    }
  }
  say(JSON.stringify({ directory, written }));
  return 0;
}
