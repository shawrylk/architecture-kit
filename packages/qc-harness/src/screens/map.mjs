import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveStackTargets } from "./stack-auth.mjs";

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const text = (value) => typeof value === "string" && value.length > 0;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

/** Branch: seed credentials belong only to a loopback origin. */
export function requireLocalhost(value) {
  const url = new URL(value);
  requireValue(["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password, "seed-login requires localhost");
}

/** Record: validate the map before opening a browser or creating output files. */
export function parseMap(input) {
  requireValue(input && typeof input === "object", "Expected a screen map");
  requireValue(Array.isArray(input.widths) && input.widths.length > 0 && input.widths.every(w => Number.isInteger(w) && w > 0 && w <= 10000), "widths must contain positive integers up to 10000");
  requireValue(input.targets && Object.keys(input.targets).length >= 2, "At least two targets are required");
  for (const [name, target] of Object.entries(input.targets)) {
    requireValue(namePattern.test(name) && name !== "pair", "Invalid target name");
    const url = new URL(target.baseUrl);
    requireValue(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.port !== "5432", "Targets require HTTP URLs without credentials");
    const auth = target.auth;
    requireValue(auth && text(auth.signedIn), "auth.signedIn must identify a signed-in page");
    if (auth.mode === "browser-session") {
      requireValue(text(auth.domain) && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(auth.domain), "Invalid Auth0 domain");
    } else if (auth.mode === "form") {
      requireLocalhost(target.baseUrl);
      for (const field of ["userSelector", "passwordSelector", "submitSelector"]) requireValue(text(auth[field]), `form requires ${field}`);
    } else {
      requireValue(auth.mode === "seed-login", "Unknown auth mode");
      requireLocalhost(target.baseUrl);
      for (const field of ["seedFile", "userField", "passwordField", "userSelector", "passwordSelector", "submitSelector"]) requireValue(text(auth[field]), `seed-login requires ${field}`);
    }
  }
  requireValue(Array.isArray(input.screens) && input.screens.length > 0, "screens must be a nonempty array");
  const names = new Set();
  for (const screen of input.screens) {
    requireValue(namePattern.test(screen.name) && !names.has(screen.name), "Invalid or duplicate screen name");
    names.add(screen.name);
    requireValue(screen.targets && Object.keys(screen.targets).length >= 2, "Each screen needs two targets");
    for (const [name, route] of Object.entries(screen.targets)) {
      requireValue(input.targets[name], `Unknown target ${name}`);
      requireValue(text(route.path) && route.path.startsWith("/") && !route.path.startsWith("//") && !route.path.includes("\\"), "Screen paths must stay on the target origin");
      requireValue(new URL(route.path, input.targets[name].baseUrl).origin === new URL(input.targets[name].baseUrl).origin, "Screen path changes origin");
      if (route.masks !== undefined) requireValue(Array.isArray(route.masks) && route.masks.every(text), "masks must contain selectors");
      if (route.clicks !== undefined) requireValue(Array.isArray(route.clicks) && route.clicks.every(step => text(step) || (step && text(step.selector) && typeof step.optional === "boolean")), "clicks must contain selectors or optional navigation steps");
      if (route.ready !== undefined) requireValue(text(route.ready), "ready must be a selector");
    }
  }
  return input;
}

/** Resource: resolve a seed file relative to its map. */
export function loadMap(file, { targets } = {}) {
  const map = parseMap(resolveStackTargets(JSON.parse(readFileSync(file, "utf8")), targets));
  if (map.catalog) map.catalog = path.resolve(path.dirname(file), map.catalog);
  for (const target of Object.values(map.targets)) if (target.auth.mode === "seed-login") target.auth.seedFile = path.resolve(path.dirname(file), target.auth.seedFile);
  return map;
}
