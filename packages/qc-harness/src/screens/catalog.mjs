import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { privateRoot } from "./auth.mjs";

/** Record: catalog names are portable paths below the output directory. */
export function screen(entry) {
  if (!/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i.test(entry.name ?? "")) throw new Error("Invalid catalog screen name");
  if (!entry.open || typeof entry.open !== "object") throw new Error(`Screen ${entry.name} requires open functions`);
  return entry;
}

/** Resource: each area exports entries or an array of entries. */
export async function loadCatalog(directory) {
  const entries = [];
  const walk = async dir => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (/\.(?:ts|mjs|js)$/.test(item.name) && !/\.d\.ts$/.test(item.name)) {
        const module = await import(pathToFileURL(file).href);
        for (const value of Object.values(module)) for (const entry of Array.isArray(value) ? value : [value]) {
          if (entry?.name && entry?.open) entries.push(screen(entry));
        }
      }
    }
  };
  await walk(directory);
  const names = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`Duplicate catalog screen ${entry.name}`);
    names.add(entry.name);
  }
  return entries;
}

/** Record: navigation receives fixture ids and names every fallible step. */
export function navigationContext(page, target, targetName, screenName, out) {
  const file = path.join(privateRoot(), `fixtures-${targetName}.json`);
  const fixtures = { ...(target.fixtures ?? {}), ...(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) };
  return { baseUrl: target.baseUrl, fixtures, target: targetName, async step(name, action) {
    try { return await action(); }
    catch (cause) {
      if (cause.step) throw cause;
      const screenshot = `${screenName}/failure-${targetName}-${name.replace(/[^a-z0-9_-]/gi, "_")}.png`;
      mkdirSync(path.dirname(path.join(out, screenshot)), { recursive: true });
      await page.screenshot({ path: path.join(out, screenshot) }).catch(() => {});
      throw Object.assign(new Error(`Screen ${screenName}, target ${targetName}, step ${name} failed`), { screen: screenName, target: targetName, step: name, screenshot });
    }
  } };
}

/** Pipeline: bind shared app navigation to each cloud or local target. */
export async function applyCatalog(map, mapFile) {
  if (!map.catalog) return map;
  const entries = await loadCatalog(path.resolve(path.dirname(mapFile), map.catalog));
  map.screens = entries.map(entry => ({ name: entry.name, signatures: entry.signatures, targets: Object.fromEntries(Object.entries(map.targets).flatMap(([name, target]) => {
    const family = target.family ?? name.split("-")[0];
    const key = entry.open[name] ? name : family;
    if (!entry.open[key]) return [];
    const original = map.screens.find(item => item.name === entry.name)?.targets[name] ?? {};
    return [[name, { ...original, path: entry.paths?.[key] ?? original.path, ready: entry.ready?.[key] ?? original.ready, masks: entry.masks?.[key] ?? original.masks, exclude: entry.exclude?.[key] ?? original.exclude, open: entry.open[key], navigationSource: String(entry.open[key]) }]];
  })) }));
  return map;
}

/** Pipeline: catalog functions use named steps and an explicit ready state. */
export async function openScreen(page, target, route, { targetName, screenName, out, timeout = 15000 }) {
  const ctx = navigationContext(page, target, targetName, screenName, out);
  await ctx.step("Open screen", () => route.open(page, ctx));
  if (route.ready) await ctx.step("Ready", () => page.locator(route.ready).first().waitFor({ state: "visible", timeout }));
}
