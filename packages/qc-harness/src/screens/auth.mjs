import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireLocalhost } from "./map.mjs";
import { installWriteGuard } from "./write-guard.mjs";

/** Branch: a failed session advances to the next method. */
export async function firstSignedIn(methods) {
  for (const method of methods) {
    const session = await method();
    if (session) return session;
  }
  throw new Error("No signed-in page reached; complete sign-in in the headed Chrome window and rerun");
}

/** Resource: authentication files stay outside every repository. */
export function privateRoot() {
  const root = path.join(os.homedir(), ".qc", "screens");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let current = realpathSync(root); ; current = path.dirname(current)) {
    if (existsSync(path.join(current, ".git"))) throw new Error("The screens state directory must stay outside every repository");
    if (current === path.dirname(current)) break;
  }
  return root;
}

/** Resource: copy session files without opening the password store. */
export function copyChromeProfile(root, source) {
  const chrome = source ?? (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data") : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome") : path.join(os.homedir(), ".config", "google-chrome"));
  const localState = path.join(chrome, "Local State");
  const profileName = JSON.parse(readFileSync(localState, "utf8")).profile?.last_used ?? "Default";
  if (!/^(Default|Profile \d+)$/.test(profileName)) throw new Error("Chrome profile name is unsupported");
  const destination = path.join(root, "profile");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  cpSync(localState, path.join(destination, "Local State"));
  const output = path.join(destination, profileName);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const name of ["Cookies", "Cookies-journal", "Network/Cookies", "Network/Cookies-journal", "Local Storage", "IndexedDB", "Preferences", "Secure Preferences"]) {
    const file = path.join(chrome, profileName, name);
    if (existsSync(file)) cpSync(file, path.join(output, name), { recursive: true });
  }
  return { directory: destination, profileName };
}

async function reachesSignedIn(context, target, timeout) {
  const page = await context.newPage();
  await page.goto(new URL(target.auth.path ?? "/projects", target.baseUrl).href, { waitUntil: "domcontentloaded", timeout });
  await page.locator(target.auth.signedIn).first().waitFor({ state: "visible", timeout });
  if (new URL(page.url()).origin !== new URL(target.baseUrl).origin) throw new Error("Sign-in finished on another origin");
  return { context, page };
}

async function saveState(context, file) {
  const state = await context.storageState();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Pipeline: reuse state, then Chrome's copied profile, then an interactive sign-in. */
export async function browserSession(chromium, target, { timeout = 15000, signInTimeout = 180000, say = console.error, chromeProfile, allowInteractive = true, headed = false, allowWrites = false } = {}) {
  const root = privateRoot();
  const file = path.join(root, "state", `${target.auth.domain}.json`);
  const launch = async (method) => {
    let context;
    let browser;
    try {
      if (method === "profile") {
        const profile = copyChromeProfile(root, chromeProfile);
        context = await chromium.launchPersistentContext(profile.directory, { channel: "chrome", headless: !headed, deviceScaleFactor: 1, reducedMotion: "reduce", args: [`--profile-directory=${profile.profileName}`] });
      } else {
        if (method === "state" && !existsSync(file)) return null;
        browser = await chromium.launch({ channel: "chrome", headless: !headed && method !== "headed" });
        context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block", ...(method === "state" ? { storageState: file } : {}) });
      }
      await installWriteGuard(context, target, { allowWrites });
      if (method === "headed") say("Sign in once in the Chrome window. The tool waits for the signed-in page.");
      const session = await reachesSignedIn(context, target, method === "headed" ? signInTimeout : timeout);
      await saveState(context, file);
      return { ...session, close: async () => { await context.close(); if (browser) await browser.close(); } };
    } catch (error) {
      if (context) await context.close();
      if (browser) await browser.close();
      if (method === "profile") say(`Auth step 2 failed: ${error.code === "EBUSY" || error.code === "EPERM" ? "Chrome locked a session file during the profile copy" : error.code === "ENOENT" ? "Chrome profile files are unavailable" : "the copied Chrome profile did not reach the signed-in page"}.`);
      return null;
    }
  };
  return firstSignedIn(allowInteractive ? [() => launch("state"), () => launch("profile"), () => launch("headed")] : [() => launch("state")]);
}

/** Resource: read only named fields, without evaluating seed code. */
export function seedFields(auth) {
  try {
    const source = readFileSync(auth.seedFile, "utf8");
    let json;
    try { json = JSON.parse(source); } catch { json = null; }
    const field = name => {
      if (json) return name.split(".").reduce((value, key) => value?.[key], json);
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error("Invalid seed field");
      const match = source.match(new RegExp(`(?:\\b${name}\\s*[:=]\\s*)(["'\x60])([^"'\x60\\r\\n]+)\\1`));
      return match?.[2];
    };
    const user = field(auth.userField);
    const password = field(auth.passwordField);
    if (typeof user !== "string" || typeof password !== "string" || !user || !password) throw new Error("Missing seed fields");
    return { user, password };
  } catch {
    throw new Error("Cannot read the named seed fields");
  }
}

/** Pipeline: fill credentials only while every request stays on loopback. */
export async function seedSession(chromium, target, { timeout = 15000, credentials, savedOnly = false, headed = false } = {}) {
  requireLocalhost(target.baseUrl);
  const file = path.join(privateRoot(), `local-${new URL(target.baseUrl).port || "80"}.json`);
  if (savedOnly && !existsSync(file)) throw new Error("No saved local session");
  const browser = await chromium.launch({ channel: "chrome", headless: !headed });
  const context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: "reduce", ...(existsSync(file) ? { storageState: file } : {}) });
  try {
    await context.route("**/*", async route => {
      try { requireLocalhost(route.request().url()); } catch { await route.abort(); return; }
      await route.continue();
    });
    if (savedOnly) {
      const session = await reachesSignedIn(context, { ...target, auth: { ...target.auth, path: target.auth.checkPath ?? "/projects" } }, timeout);
      await saveState(context, file);
      return { ...session, close: () => browser.close() };
    }
    const page = await context.newPage();
    await page.goto(new URL(target.auth.path ?? "/login", target.baseUrl).href, { waitUntil: "domcontentloaded", timeout });
    requireLocalhost(page.url());
    const { user, password } = credentials ?? seedFields(target.auth);
    await page.locator(target.auth.userSelector).fill(user, { timeout });
    requireLocalhost(page.url());
    await page.locator(target.auth.passwordSelector).fill(password, { timeout });
    requireLocalhost(page.url());
    await page.locator(target.auth.submitSelector).click({ timeout });
    await page.locator(target.auth.signedIn).first().waitFor({ state: "visible", timeout });
    await saveState(context, file);
    return { context, page, close: () => browser.close() };
  } catch {
    await browser.close();
    throw new Error("Local seed sign-in failed");
  }
}
