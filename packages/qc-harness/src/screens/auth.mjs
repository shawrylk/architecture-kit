import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { atomicJson, withFileLock } from "./session-files.mjs";
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

async function saveState(context, file, target) {
  // A parent-domain cookie, such as .auth0.com, reaches every tenant on that domain, so only exact hosts are kept.
  const hosts = [new URL(target.baseUrl).hostname, target.auth.domain].filter(Boolean).map(host => host.toLowerCase());
  const origins = [new URL(target.baseUrl).origin, ...(target.auth.domain ? [`https://${target.auth.domain.toLowerCase()}`] : [])];
  const state = await context.storageState();
  state.cookies = state.cookies.filter(cookie => hosts.includes(cookie.domain.replace(/^\./, "").toLowerCase()));
  state.origins = state.origins.filter(origin => origins.includes(new URL(origin.origin).origin));
  await atomicJson(file, state);
}

/** Record: interactive sign-in is a terminal result for unattended commands. */
export class PersonSignInRequired extends Error {
  constructor(targetName) {
    super(`${targetName}: needs a person to sign in (run qc screens auth ${targetName} --headed)`);
    this.exitCode = 4;
  }
}

/** Pipeline: reuse saved cookies and refresh through the real login page without typing. */
export async function browserSession(chromium, target, options = {}) {
  const { targetName = target.name ?? target.baseUrl } = options;
  try {
    const file = path.join(privateRoot(), "state", `${target.auth.domain}.json`);
    return await withFileLock(file, () => lockedBrowserSession(chromium, target, file, { ...options, targetName }));
  } catch (error) {
    if (error instanceof PersonSignInRequired || error.authFailure) throw error;
    throw authFailure(targetName, "browser-session", "the session files");
  }
}

function authFailure(targetName, method, stage) {
  const error = new Error(`${targetName}: ${method} sign-in failed at ${stage}`);
  error.authFailure = true;
  return error;
}

async function lockedBrowserSession(chromium, target, file, { timeout = 15000, signInTimeout = 180000, say = console.error, chromeProfile, allowInteractive = false, headed = false, allowWrites = false, targetName }) {
  const launch = async method => {
    let context, browser, profileRoot;
    let stage = "the copied Chrome profile";
    const close = async () => {
      try { if (context) await context.close(); }
      finally {
        try { if (browser) await browser.close(); }
        finally { if (profileRoot) rmSync(profileRoot, { recursive: true, force: true }); }
      }
    };
    try {
      if (method === "profile") {
        profileRoot = path.join(privateRoot(), `profile-${process.pid}-${Date.now()}`);
        const profile = copyChromeProfile(profileRoot, chromeProfile);
        stage = "the browser";
        context = await chromium.launchPersistentContext(profile.directory, { channel: "chrome", headless: !headed, deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block", args: [`--profile-directory=${profile.profileName}`] });
      } else {
        if (method === "state" && !existsSync(file)) return null;
        stage = "the browser";
        browser = await chromium.launch({ channel: "chrome", headless: !headed && method !== "headed" });
        stage = "the session file";
        const storageState = method === "state" ? JSON.parse(readFileSync(file, "utf8")) : undefined;
        stage = "the browser";
        context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block", ...(storageState ? { storageState } : {}) });
      }
      await installWriteGuard(context, target, { allowWrites });
      if (method === "headed") say(`${targetName}: sign in once in the Chrome window.`);
      stage = "the login page";
      let session;
      if (method === "state") {
        try {
          session = await reachesSignedIn(context, { ...target, auth: { ...target.auth, path: target.auth.checkPath ?? "/projects" } }, timeout);
        } catch {
          for (const page of context.pages()) await page.close();
          const loginPath = target.auth.loginPath ?? (target.auth.path && target.auth.path !== "/projects" ? target.auth.path : "/bff/login?returnTo=%2Fprojects");
          session = await reachesSignedIn(context, { ...target, auth: { ...target.auth, path: loginPath } }, timeout);
        }
      } else session = await reachesSignedIn(context, target, method === "headed" ? signInTimeout : timeout);
      stage = "the session file";
      await saveState(context, file, target);
      return { ...session, close };
    } catch {
      await close().catch(() => {});
      if (stage === "the browser" || stage === "the session file") throw authFailure(targetName, "browser-session", stage);
      if (allowInteractive) say(`${targetName}: browser-session sign-in failed at the ${method === "state" ? "saved session and silent refresh" : method === "profile" ? "copied Chrome profile" : "headed login page"}.`);
      return null;
    }
  };
  const methods = allowInteractive ? ["state", "profile", "headed"] : ["state"];
  for (const method of methods) {
    const session = await launch(method);
    if (session) return session;
  }
  throw new PersonSignInRequired(targetName);
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
export async function seedSession(chromium, target, options = {}) {
  const { targetName = target.name ?? target.baseUrl } = options;
  const method = target.auth.mode === "form" ? "form" : "seed";
  try {
    requireLocalhost(target.baseUrl);
    const file = path.join(privateRoot(), `local-${new URL(target.baseUrl).port || "80"}.json`);
    return await withFileLock(file, () => lockedSeedSession(chromium, target, file, { ...options, targetName, method }));
  } catch (error) {
    if (error.authFailure) throw error;
    throw authFailure(targetName, method, "the localhost guard or session files");
  }
}

async function lockedSeedSession(chromium, target, file, { timeout = 15000, credentials, savedOnly = false, headed = false, targetName, method }) {
  let browser;
  let stage = "the saved session";
  try {
    if (savedOnly && !existsSync(file)) throw new Error("No saved local session");
    stage = "the browser";
    browser = await chromium.launch({ channel: "chrome", headless: !headed });
    const context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block", ...(existsSync(file) ? { storageState: JSON.parse(readFileSync(file, "utf8")) } : {}) });
    await context.route("**/*", async route => {
      try { requireLocalhost(route.request().url()); } catch { await route.abort(); return; }
      await route.continue();
    });
    if (savedOnly) {
      stage = "the saved session";
      const session = await reachesSignedIn(context, { ...target, auth: { ...target.auth, path: target.auth.checkPath ?? "/projects" } }, timeout);
      await saveState(context, file, target);
      return { ...session, close: () => browser.close() };
    }
    stage = "the login page";
    const page = await context.newPage();
    await page.goto(new URL(target.auth.path ?? "/login", target.baseUrl).href, { waitUntil: "domcontentloaded", timeout });
    requireLocalhost(page.url());
    stage = "the credential fields";
    const { user, password } = credentials ?? seedFields(target.auth);
    stage = "the username field";
    await page.locator(target.auth.userSelector).fill(user, { timeout });
    requireLocalhost(page.url());
    stage = "the password field";
    await page.locator(target.auth.passwordSelector).fill(password, { timeout });
    requireLocalhost(page.url());
    stage = "the submit control";
    await page.locator(target.auth.submitSelector).click({ timeout });
    stage = "the signed-in page";
    await page.locator(target.auth.signedIn).first().waitFor({ state: "visible", timeout });
    stage = "the session file";
    await saveState(context, file, target);
    return { context, page, close: () => browser.close() };
  } catch {
    if (browser) await browser.close().catch(() => {});
    throw authFailure(targetName, method, stage);
  }
}
