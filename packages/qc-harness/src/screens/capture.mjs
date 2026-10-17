import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { targetSession } from "./stack-auth.mjs";
import { compareImages, gallery, sortReport } from "./compare.mjs";
import { stableCapture, findRegions, regionCrop, boxPair } from "./regions.mjs";
import { collectInventory, diffInventory, inventoryBox } from "./inventory.mjs";
import { openScreen } from "./catalog.mjs";
import { safeControl, installWriteGuard } from "./write-guard.mjs";

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
  return safeControl(control);
}

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

function writeJson(file, value) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** Pipeline: wait for page resources before recording the viewport. */
export async function capturePage(session, target, route, width, height, file, timeout, navigation = {}) {
  const { page } = session;
  await page.setViewportSize({ width, height });
  if (route.open) await openScreen(page, target, route, { ...navigation, timeout });
  const expected = new URL(route.path ?? page.url(), target.baseUrl);
  const response = route.open ? null : await page.goto(expected.href, { waitUntil: "domcontentloaded", timeout });
  if (response && response.status() >= 400) throw new Error(`Capture received HTTP ${response.status()}`);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
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
  const actual = new URL(page.url());
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search !== expected.search) throw new Error("Capture reached a URL other than the mapped screen");
  if (await page.locator('input[type="password"]:visible, [role="alert"][data-error]:visible').count()) throw new Error("Capture reached a sign-in or error page");
  await page.mouse.move(0, 0);
  await page.waitForLoadState("networkidle", { timeout });
  await page.evaluate(() => document.fonts.ready);
  const inventory = await collectInventory(page, [...(route.masks ?? []), ...(route.exclude ?? [])]);
  writeJson(file.replace(/\.png$/, ".inventory.json"), inventory);
  const capture = () => page.screenshot({ animations: "disabled", caret: "hide", fullPage: false, mask: (route.masks ?? []).map(selector => page.locator(selector)), maskColor: "#808080", timeout }).then(buffer => PNG.sync.read(buffer));
  const full = await stableCapture(capture);
  writeFileSync(file, PNG.sync.write(full.image));
  const style = await page.addStyleTag({ content: "*,*::before,*::after{color:transparent!important;text-shadow:none!important;-webkit-text-fill-color:transparent!important}img,canvas,video,svg{visibility:hidden!important}*:has(>img),*:has(>canvas),*:has(>video),*:has(>svg){background:#808080!important}input,textarea{color:transparent!important}" });
  const layout = await stableCapture(capture);
  await style.evaluate(element => element.remove());
  writeFileSync(file.replace(/\.png$/, ".layout.png"), PNG.sync.write(layout.image));
  const unstable = new PNG({ width, height });
  for (const mask of [full.unstable, layout.unstable].filter(Boolean)) for (let i = 3; i < mask.data.length; i += 4) if (mask.data[i]) unstable.data.set([255, 0, 0, 255], i - 3);
  writeFileSync(file.replace(/\.png$/, ".unstable.png"), PNG.sync.write(unstable));
}

/** Pipeline: authenticate, capture each viewport, compare, and publish the gallery. */
export async function captureScreens(map, options, { chromium, say = console.error, sessionFactory = targetSession } = {}) {
  const { targets, out, only, changed, timeout = 15000, signInTimeout = 180000, height = 900 } = options;
  if (targets.length !== 2 || targets.some(name => !map.targets[name])) throw new Error("Choose two targets from the map");
  if (changed && !targets.includes(changed)) throw new Error("--changed must name one of the two targets");
  const screens = selectScreens(map.screens, only);
  for (const screen of screens) for (const name of targets) if (!screen.targets[name]) throw new Error(`Screen ${screen.name} lacks target ${name}`);
  mkdirSync(out, { recursive: true });
  const cacheFile = path.join(out, "captures.json");
  const cache = readJson(cacheFile, {});
  const sessions = new Map();
  const fresh = [];
  const failures = new Map();
  try {
    for (const name of targets) {
      const target = map.targets[name];
      if (changed && changed !== name) {
        for (const screen of screens) for (const width of map.widths) {
          const relative = `${screen.name}/${name}@${width}.png`;
          if (![relative, relative.replace(/\.png$/, ".layout.png"), relative.replace(/\.png$/, ".unstable.png"), relative.replace(/\.png$/, ".inventory.json")].every(file => existsSync(path.join(out, file))) || cache[relative] !== captureKey(target, screen.targets[name], width, height)) throw new Error(`Cached capture missing or stale: ${relative}; run both targets first`);
        }
        continue;
      }
      const session = await sessionFactory(chromium, target, { timeout, signInTimeout, say });
      sessions.set(name, session);
      await installWriteGuard(session.context, target);
      for (const screen of screens) {
        mkdirSync(path.join(out, screen.name), { recursive: true });
        for (const width of map.widths) {
          const relative = `${screen.name}/${name}@${width}.png`;
          try {
            await capturePage(session, target, screen.targets[name], width, height, path.join(out, relative), timeout, { targetName: name, screenName: screen.name, out });
          } catch (error) {
            failures.set(`${screen.name}@${width}`, { target: name, step: error.step ?? "Capture", screenshot: error.screenshot, message: error.message });
            say(error.message);
            continue;
          }
          cache[relative] = captureKey(target, screen.targets[name], width, height);
          writeJson(cacheFile, cache);
          say(`Captured ${relative}`);
        }
      }
      await session.close();
      sessions.delete(name);
    }
    for (const screen of screens) for (const width of map.widths) {
      const error = failures.get(`${screen.name}@${width}`);
      if (error) { fresh.push({ screen: screen.name, width, targets, error, regions: [], inventoryFindings: [] }); continue; }
      const images = targets.map(name => PNG.sync.read(readFileSync(path.join(out, screen.name, `${name}@${width}.png`))));
      const { pair, ...diff } = compareImages(...images);
      const layouts = targets.map(name => PNG.sync.read(readFileSync(path.join(out, screen.name, `${name}@${width}.layout.png`))));
      const unstable = new PNG({ width: layouts[0].width, height: layouts[0].height });
      for (const name of targets) {
        const mask = PNG.sync.read(readFileSync(path.join(out, screen.name, `${name}@${width}.unstable.png`)));
        for (let i = 3; i < mask.data.length; i += 4) if (mask.data[i]) unstable.data.set([255, 0, 0, 255], i - 3);
      }
      const regions = findRegions(...layouts, { unstable: [unstable] });
      for (const region of regions) {
        region.crop = `${screen.name}/region-${region.id}@${width}.png`;
        writeFileSync(path.join(out, region.crop), PNG.sync.write(regionCrop(...images, region.box)));
      }
      const inventories = targets.map(name => readJson(path.join(out, screen.name, `${name}@${width}.inventory.json`), []));
      const inventoryFindings = diffInventory(...inventories);
      for (const finding of inventoryFindings) {
        finding.id += regions.length;
        finding.box = inventoryBox(finding, images[0].width, images[0].height);
        finding.crop = `${screen.name}/inventory-${finding.id}@${width}.png`;
        writeFileSync(path.join(out, finding.crop), PNG.sync.write(regionCrop(...images, finding.box)));
      }
      const relative = `${screen.name}/pair@${width}.png`;
      writeFileSync(path.join(out, relative), PNG.sync.write(boxPair(pair, [...regions, ...inventoryFindings])));
      fresh.push({ screen: screen.name, width, targets, ...diff, regions, inventoryFindings, pair: relative });
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
