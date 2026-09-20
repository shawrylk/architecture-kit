// The API decides which routes need no session; the BFF must let exactly those
// through. They are separate services, so the set is written twice — QC-007:
// where a tool demands a literal, assert agreement rather than forbid it.
//
// Drift in either direction is a finding. A route the API opened that the BFF
// still guards is dead; a route the BFF opens that the API guards is a hole.

const DEFAULT_AUTH_KEY = "auth";
const DEFAULT_PUBLIC_VALUE = "public";

function publicRoutePattern(key, value) {
  return new RegExp(`\\{\\s*method:\\s*"(\\w+)",\\s*path:\\s*"([^"]+)",\\s*${key}:\\s*"${value}"`, "g");
}
const BFF_ENTRY = /\{\s*method:\s*"(\w+)",\s*path:\s*"([^"]+)"\s*\}/g;

function collect(source, pattern) {
  const found = new Set();
  pattern.lastIndex = 0;
  let match = pattern.exec(source);
  while (match !== null) {
    found.add(`${match[1].toUpperCase()} ${match[2]}`);
    match = pattern.exec(source);
  }
  return found;
}

/** Every route a backend trigger declares `auth: "public"`. */
export function declaredPublicRoutes(triggerSources, options = {}) {
  const PUBLIC_ROUTE = publicRoutePattern(
    options.authKey ?? DEFAULT_AUTH_KEY,
    options.publicValue ?? DEFAULT_PUBLIC_VALUE,
  );
  const found = new Set();
  for (const source of triggerSources) {
    for (const route of collect(source, PUBLIC_ROUTE)) found.add(route);
  }
  return found;
}

/** Every route the BFF forwards without a session. */
export function allowedPublicRoutes(source) {
  return collect(source, BFF_ENTRY);
}

/** @returns {{path: string, rule: string, detail: string}[]} */
export function checkPublicRoutes(declared, allowed, label) {
  const problems = [];
  for (const route of [...declared].sort()) {
    if (!allowed.has(route)) {
      problems.push({
        path: label,
        rule: "public-route-unreachable",
        detail: `the api serves '${route}' without a session, but the bff still demands one`,
      });
    }
  }
  for (const route of [...allowed].sort()) {
    if (!declared.has(route)) {
      problems.push({
        path: label,
        rule: "public-route-unguarded",
        detail: `the bff forwards '${route}' with no session, but no api route declares itself public`,
      });
    }
  }
  return problems;
}
