import path from "node:path";
import { parseArgs } from "node:util";
import { loadMap } from "../screens/map.mjs";
import { captureScreens } from "../screens/capture.mjs";
import { authStatus, targetSession } from "../screens/stack-auth.mjs";
import { applyCatalog, openScreen } from "../screens/catalog.mjs";
import { runDiscovery } from "./screens-discovery.mjs";
import { setupLocal } from "../screens/setup.mjs";

export const USAGE = `qc screens [run [names...]|list|open <name>|auth status|setup]
  qc screens discover|pair|coverage|scaffold --map <json> --out <dir>
  --map <json> [--targets <left,right>] [--target <name>] [--out <dir>]
  [--only <names>] [--changed <target>] [--height <pixels>]
  [--timeout <milliseconds>] [--sign-in-timeout <milliseconds>]
  [--depth <levels>] [--max-states <count>] [--allow-writes] [--catalog-out <dir>]

Chrome must be installed. Sessions stay in ~/.qc/screens.
Catalog modules live outside the kit. open waits until you close its window.`;

/** Trigger: screen commands share the same catalog, sessions, and map. */
export async function runScreens(argv, { say = console.error } = {}) {
  let values, positionals;
  const command = argv[0]?.startsWith("--") || !argv.length ? "run" : argv.shift();
  const authCommand = command === "auth" && argv.shift() === "status";
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { map: { type: "string" }, targets: { type: "string" }, target: { type: "string" }, out: { type: "string" }, only: { type: "string" }, changed: { type: "string" }, height: { type: "string" }, timeout: { type: "string" }, "sign-in-timeout": { type: "string" }, depth: { type: "string" }, "max-states": { type: "string" }, "allow-writes": { type: "boolean" }, "catalog-out": { type: "string" }, help: { type: "boolean" } } }));
    if (values.help) { say(USAGE); return 0; }
    if (!values.map) throw new Error("--map is required");
    for (const field of ["height", "timeout", "sign-in-timeout"]) if (values[field] !== undefined && (!Number.isInteger(Number(values[field])) || Number(values[field]) < 1)) throw new Error(`--${field} must be a positive integer`);
    const selectedTargets = values.targets?.split(",") ?? (values.target ? [values.target] : command === "list" ? [] : undefined);
    const map = await applyCatalog(loadMap(path.resolve(values.map), { targets: selectedTargets }), path.resolve(values.map));
    if (command === "list") {
      for (const item of map.screens) say(`${item.name}\t${Object.keys(item.targets).join(", ")}`);
      return 0;
    }
    const { chromium } = await import("playwright");
    if (command === "setup") {
      const target = map.targets[values.target];
      if (!target) throw new Error("Choose --target from the map");
      say(JSON.stringify(await setupLocal(target, values.target, { chromium, timeout: Number(values.timeout ?? 15000), signInTimeout: Number(values["sign-in-timeout"] ?? 180000), say })));
      return 0;
    }
    if (["discover", "pair", "coverage", "scaffold"].includes(command)) return await runDiscovery(command, map, values, { chromium, say });
    const timeout = Number(values.timeout ?? 15000);
    const signInTimeout = Number(values["sign-in-timeout"] ?? 180000);
    if (authCommand) {
      const targets = values.target ? { [values.target]: map.targets[values.target] } : map.targets;
      if (Object.values(targets).some(target => !target)) throw new Error("Unknown target");
      for (const row of await authStatus(chromium, targets, { timeout })) say(JSON.stringify(row));
      return 0;
    }
    if (command === "open") {
      const target = map.targets[values.target];
      const item = map.screens.find(item => item.name === positionals[0]);
      const route = item?.targets[values.target];
      if (!target || !route) throw new Error("Choose a screen name and --target from the map");
      const session = await targetSession(chromium, target, { timeout, signInTimeout, say, headed: true });
      try {
        await session.page.setViewportSize({ width: map.widths[0], height: Number(values.height ?? 900) });
        if (route.open) await openScreen(session.page, target, route, { targetName: values.target, screenName: item.name, out: path.resolve(values.out ?? "."), timeout });
        else await session.page.goto(new URL(route.path, target.baseUrl).href, { timeout });
        await new Promise(resolve => session.page.once("close", resolve));
      } finally { await session.close().catch(() => {}); }
      return 0;
    }
    if (command !== "run") throw new Error(`Unknown screens command ${command}`);
    if (!values.targets || !values.out) throw new Error("--targets and --out are required");
    const report = await captureScreens(map, { targets: values.targets.split(",").map(name => name.trim()), out: path.resolve(values.out), only: positionals.length ? positionals.join(",") : values.only, changed: values.changed, height: Number(values.height ?? 900), timeout, signInTimeout }, { chromium, say });
    for (const row of report) say(JSON.stringify(row));
    return report.some(row => row.error) ? 1 : 0;
  } catch (error) { say(`qc screens: ${error.message}`); return 1; }
}
