import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { browserSession, seedSession } from "./auth.mjs";
import { compareImages, gallery, sortReport } from "./compare.mjs";

/** Branch: a typo must never silently skip a requested screen. */
export function selectScreens(screens, only) {
  if (!only) return screens;
  const names = only.split(",").map(name => name.trim());
  for (const name of names) if (!screens.some(screen => screen.name === name)) throw new Error(`Unknown screen ${name}`);
  return screens.filter(screen => names.includes(screen.name));
}

/** Record: bind a cached image to its viewport, target, navigation, and masks. */
export function captureKey(target, route, width, height) {
  return createHash("sha256").update(JSON.stringify({ baseUrl: target.baseUrl, route, width, height })).digest("hex");
}

/** Ledger: a filtered rerun preserves rows for the same pair. */
export function mergeReport(previous, fresh) {
  const keys = new Set(fresh.map(row => `${row.screen}@${row.width}`));
  const targets = JSON.stringify(fresh[0]?.targets);
  return sortReport([...previous.filter(row => JSON.stringify(row.targets) === targets && !keys.has(`${row.screen}@${row.width}`)), ...fresh]);
}

/** Branch: capture navigation excludes mutation controls. */
export function safeClick(control) {
  return control.type !== "submit" && !/save|delete|submit|complete|\u4fdd\u5b58|\u524a\u966|\u9001\u4fe1|\u5b8c\u4e86/i.test(control.text);
}

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

function writeJson(file, value) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** Pipeline: wait for page resources before recording the viewport. */
export async function capturePage(session, target, route, width, height, file, timeout) {
  const { page } = session;
  await page.setViewportSize({ width, height });
  await page.goto(new URL(route.path, target.baseUrl).href, { waitUntil: "domcontentloaded", timeout });
  await page.locator(target.auth.signedIn).first().waitFor({ state: "visible", timeout });
  for (const step of route.clicks ?? []) {
    const selector = typeof step === "string" ? step : step.selector;
    const control = page.locator(selector).first();
    if (step.optional) {
      try { await control.waitFor({ state: "visible", timeout: Math.min(timeout, 1500) }); }
      catch (error) { if (error.name === "TimeoutError") continue; throw error; }
    }
    const description = await control.evaluate(element => ({ type: element.getAttribute("type") ?? (element.tagName === "BUTTON" && element.closest("form") ? "submit" : ""), text: `${element.textContent} ${element.getAttribute("aria-label") ?? ""}` }));
    if (!safeClick(description)) throw new Error("Capture navigation refuses a mutation control");
    await control.click({ timeout });
  }
  if (route.ready) await page.locator(route.ready).first().waitFor({ state: "visible", timeout });
  if (new URL(page.url()).origin !== new URL(target.baseUrl).origin) throw new Error("Capture left the target origin");
  await page.mouse.move(0, 0);
  await page.waitForLoadState("networkidle", { timeout });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, animations: "disabled", caret: "hide", fullPage: false, mask: (route.masks ?? []).map(selector => page.locator(selector)), maskColor: "#808080", timeout });
}

/** Pipeline: authenticate, capture each viewport, compare, and publish the gallery. */
export async function captureScreens(map, options, { chromium, say = console.error } = {}) {
  const { targets, out, only, changed, timeout = 15000, signInTimeout = 180000, height = 900 } = options;
  if (targets.length !== 2 || targets[0] === targets[1] || targets.some(name => !map.targets[name])) throw new Error("Choose two distinct targets from the map");
  if (changed && !targets.includes(changed)) throw new Error("--changed must name one of the two targets");
  const screens = selectScreens(map.screens, only);
  for (const screen of screens) for (const name of targets) if (!screen.targets[name]) throw new Error(`Screen ${screen.name} lacks target ${name}`);
  mkdirSync(out, { recursive: true });
  const cacheFile = path.join(out, "captures.json");
  const cache = readJson(cacheFile, {});
  const sessions = new Map();
  const fresh = [];
  try {
    for (const name of targets) {
      const target = map.targets[name];
      if (changed && changed !== name) {
        for (const screen of screens) for (const width of map.widths) {
          const relative = `${screen.name}/${name}@${width}.png`;
          if (!existsSync(path.join(out, relative)) || cache[relative] !== captureKey(target, screen.targets[name], width, height)) throw new Error(`Cached capture missing or stale: ${relative}; run both targets first`);
        }
        continue;
      }
      const session = await (target.auth.mode === "seed-login" ? seedSession(chromium, target, { timeout }) : browserSession(chromium, target, { timeout, signInTimeout, say }));
      sessions.set(name, session);
      await session.context.route("**/*", async route => {
        const request = route.request();
        if (["GET", "HEAD", "OPTIONS"].includes(request.method())) await route.continue();
        else await route.abort();
      });
      for (const screen of screens) {
        mkdirSync(path.join(out, screen.name), { recursive: true });
        for (const width of map.widths) {
          const relative = `${screen.name}/${name}@${width}.png`;
          await capturePage(session, target, screen.targets[name], width, height, path.join(out, relative), timeout);
          cache[relative] = captureKey(target, screen.targets[name], width, height);
          writeJson(cacheFile, cache);
          say(`Captured ${relative}`);
        }
      }
      await session.close();
      sessions.delete(name);
    }
    for (const screen of screens) for (const width of map.widths) {
      const images = targets.map(name => PNG.sync.read(readFileSync(path.join(out, screen.name, `${name}@${width}.png`))));
      const { pair, ...diff } = compareImages(...images);
      const relative = `${screen.name}/pair@${width}.png`;
      writeFileSync(path.join(out, relative), PNG.sync.write(pair));
      fresh.push({ screen: screen.name, width, targets, ...diff, pair: relative });
    }
    const reportFile = path.join(out, "report.json");
    const report = only ? mergeReport(readJson(reportFile, []), fresh) : sortReport(fresh);
    writeJson(reportFile, report);
    writeFileSync(path.join(out, "index.html"), gallery(report));
    return report;
  } finally {
    for (const session of sessions.values()) await session.close();
  }
}
