import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeControl, installWriteGuard } from "./write-guard.mjs";

const normalized = text => String(text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const hash = text => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Record: source route patterns resolve only known fixture parameters. */
export function sourceRoutes(source, fixtures = {}) {
  const result = [];
  const names = { projectId: "project", folderId: "folder", photoId: "photo", drawingId: "drawing", id: "project" };
  for (const match of source.matchAll(/\bpath\s*[:=]\s*["'](\/[^"']*)["']/g)) {
    const pattern = match[1];
    let missing = false;
    const route = pattern.replace(/:([a-zA-Z]\w*)\??/g, (_, name) => {
      const value = fixtures[name] ?? fixtures[names[name]];
      if (!value) missing = true;
      return encodeURIComponent(value ?? "");
    });
    result.push({ pattern, path: missing || route.includes("*") ? null : route });
  }
  return result;
}

/** Resource: route extraction reads application source without loading its modules. */
export function readSourceRoutes(roots = [], fixtures = {}) {
  const routes = [];
  const walk = root => {
    for (const item of readdirSync(root, { withFileTypes: true })) {
      if (/^(?:node_modules|\.git|dist|build|coverage|\.worktree|\.next)$/.test(item.name)) continue;
      const file = path.join(root, item.name);
      if (item.isDirectory()) walk(file);
      else if (/\.[jt]sx?$/.test(item.name) && !/\.(?:test|spec)\./.test(item.name) && statSync(file).size < 2000000) routes.push(...sourceRoutes(readFileSync(file, "utf8"), fixtures));
    }
  };
  for (const root of roots) walk(root);
  return [...new Map(routes.map(route => [route.pattern, route])).values()];
}

const locatorFor = (page, step) => step.testId ? page.getByTestId(step.testId) : page.getByRole(step.role, { name: step.name, exact: true });

/** Record: a UI signature identifies state independently of its data rows. */
export async function stateSignature(page, pattern) {
  const read = async selector => page.locator(selector).evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width && node.getBoundingClientRect().height).map(node => node.getAttribute("aria-label") || node.textContent.trim()).join(" | "));
  const dialogs = page.getByRole("dialog");
  const dialog = await dialogs.count() ? await dialogs.last().ariaSnapshot() : "";
  return JSON.stringify({ route: pattern, dialog: dialog.split("\n")[0].replace(/^\s*-\s*/, ""), tab: await read('[role="tab"][aria-selected="true"]'), menu: await read('[role="menu"]'), heading: await read('main h1,main [role="heading"][aria-level="1"],h1'), expanded: await read('[aria-expanded="true"]') });
}

async function candidates(page) {
  const controls = page.locator('button,[role="button"],[role="tab"],[role="menuitem"],[role="combobox"],[role="switch"],summary');
  const result = [];
  for (const control of await controls.all()) {
    if (!await control.isVisible() || !await control.isEnabled()) continue;
    const data = await control.evaluate(element => ({ type: element.getAttribute("type") ?? (element.tagName === "BUTTON" && element.closest("form") ? "submit" : ""), text: `${element.textContent} ${element.getAttribute("aria-label") ?? ""}`, testId: element.getAttribute("data-testid"), role: element.getAttribute("role") ?? (element.tagName === "SUMMARY" ? "button" : "button") }));
    if (!safeControl(data)) continue;
    const snapshot = await control.ariaSnapshot().catch(() => "");
    const first = snapshot.split("\n")[0].match(/^-\s+([\w]+)(?:\s+"(.*?)")?/);
    const step = { role: first?.[1] ?? data.role, name: first?.[2] ?? "", ...(data.testId ? { testId: data.testId } : {}) };
    if (!step.testId && !step.name) continue;
    if (await locatorFor(page, step).count() !== 1) continue;
    result.push(step);
  }
  return result;
}

/** Pipeline: replay safe paths from every route and retain unique UI states. */
export async function discover(session, target, { out, targetName, widths = [2514, 390], depth = 4, timeout = 15000, allowWrites = false, maxStates = 500, say = () => {} } = {}) {
  const { page, context } = session;
  page.setDefaultTimeout(timeout);
  const states = [], errors = [], unresolvedRoutes = [];
  let blockedRequests = 0;
  await installWriteGuard(context, target, { allowWrites, onBlocked: () => blockedRequests++ });
  const discoveredRoutes = readSourceRoutes(target.sourceRoots, target.fixtures);
  for (const route of discoveredRoutes) if (!route.path) unresolvedRoutes.push(route.pattern);
  const starts = [...(target.routes ?? ["/"]).map(route => typeof route === "string" ? { path: route, pattern: route } : route), ...discoveredRoutes.filter(route => route.path)];
  const origin = new URL(target.baseUrl).origin;
  const seen = new Set();
  const queuedRoutes = new Set();
  const queue = [];
  const addRoute = (route, width) => {
    const key = `${width}:${route.path}`;
    if (!queuedRoutes.has(key)) { queuedRoutes.add(key); queue.push({ route, width, path: [] }); }
  };
  for (const width of widths) for (const route of starts) addRoute(route, width);
  mkdirSync(out, { recursive: true });
  while (queue.length) {
    if (states.length >= maxStates) { errors.push({ message: `State limit ${maxStates} reached; discovery is incomplete` }); break; }
    const current = queue.shift();
    try {
      await page.setViewportSize({ width: current.width, height: 900 });
      const response = await page.goto(new URL(current.route.path, target.baseUrl).href, { waitUntil: "domcontentloaded", timeout });
      if (response?.status() >= 400) throw new Error(`HTTP ${response.status()}`);
      for (const step of target.discoverySteps ?? []) {
        const control = locatorFor(page, step);
        if (await control.isVisible() && safeControl({ text: step.name })) await control.click({ timeout });
      }
      for (const step of current.path) await locatorFor(page, step).click({ timeout });
      await page.waitForLoadState("networkidle", { timeout });
      if (new URL(page.url()).origin !== origin) throw new Error("Discovery left the target origin");
      await page.locator(target.auth.signedIn).first().waitFor({ state: "visible", timeout });
      const actual = new URL(page.url());
      const pattern = actual.pathname === new URL(current.route.path, target.baseUrl).pathname ? current.route.pattern : actual.pathname;
      const signature = await stateSignature(page, pattern);
      const key = `${current.width}:${signature}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = hash(key);
      const thumbnail = `${targetName}-${id}.png`;
      await page.screenshot({ path: path.join(out, thumbnail), animations: "disabled" });
      const state = { id, signature, route: current.route.path, pattern, width: current.width, path: current.path, thumbnail };
      states.push(state);
      say(`Discovered ${targetName} ${current.width} ${pattern} ${id}`);
      const links = await page.locator("a[href]").evaluateAll(nodes => nodes.map(node => node.href));
      for (const href of links) {
        const url = new URL(href);
        if (url.origin === origin && !/logout|signout|delete|remove|complete/i.test(url.pathname)) addRoute({ path: url.pathname + url.search, pattern: url.pathname }, current.width);
      }
      if (current.path.length < depth) for (const step of await candidates(page)) queue.push({ ...current, path: [...current.path, step] });
    } catch (error) { errors.push({ route: current.route.path, width: current.width, path: current.path, message: error.message }); }
  }
  const counts = Object.fromEntries([...new Set(states.map(state => state.pattern))].map(route => [route, states.filter(state => state.pattern === route).length]));
  const result = { target: targetName, states, counts, errors, unresolvedRoutes, blockedRequests, complete: !errors.length && !unresolvedRoutes.length };
  writeFileSync(path.join(out, `discovered-${targetName}.json`), JSON.stringify(result, null, 2));
  return result;
}

function pairingText(state) {
  const value = JSON.parse(state.signature);
  const text = normalized([value.dialog, value.tab, value.menu, value.heading, value.expanded].filter(Boolean).join(" | "));
  return `${state.width}:${text || value.route}`;
}

/** Pipeline: match identical state text once, retaining both parity gaps. */
export function pairStates(legacy, mono) {
  const available = new Set(mono);
  const result = legacy.map(left => {
    const right = [...available].find(right => pairingText(left) === pairingText(right));
    if (right) { available.delete(right); return { kind: "paired", legacy: left, mono: right }; }
    return { kind: "legacy-only", legacy: left };
  });
  return [...result, ...[...available].map(right => ({ kind: "mono-only", mono: right }))];
}

/** Branch: every discovery needs a catalog signature or a written exclusion. */
export function catalogCoverage(states, entries, excluded = [], targetName) {
  const signatures = entries.flatMap(entry => Array.isArray(entry.signatures) ? entry.signatures : entry.signatures?.[targetName] ?? entry.signatures?.[targetName?.split("-")[0]] ?? []);
  const missing = states.filter(state => !signatures.some(signature => typeof signature === "string" ? signature === state.signature : signature.signature === state.signature && signature.width === state.width) && !excluded.some(item => item.signature === state.signature && (!item.target || item.target === targetName) && (!item.width || item.width === state.width) && item.reason?.trim()));
  return { covered: states.length - missing.length, total: states.length, missing };
}

/** Fragment: scaffold selectors replay the recorded path through named steps. */
export function scaffoldEntry(state, family) {
  const steps = state.path.map((step, index) => `    await ctx.step(${JSON.stringify(`${index + 1}. ${step.name || step.testId}`)}, () => ${step.testId ? `page.getByTestId(${JSON.stringify(step.testId)})` : `page.getByRole(${JSON.stringify(step.role)}, {name:${JSON.stringify(step.name)},exact:true})`}.click());`).join("\n");
  const name = `discovered/${family}-${state.id ?? hash(state.signature)}`;
  return `export const state${state.id ?? hash(state.signature)} = {\n  name:${JSON.stringify(name)},\n  signatures:{${JSON.stringify(family)}:[${JSON.stringify({ signature: state.signature, width: state.width })}]},\n  open:{${JSON.stringify(family)}:async (page, ctx) => {\n    await ctx.step("Navigate", () => page.goto(new URL(${JSON.stringify(state.route)},ctx.baseUrl).href));\n${steps}\n  }}\n};\n`;
}
