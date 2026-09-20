// A worker calls the api by building a path string. Nothing type-checks that
// string against the route table, so renaming a route leaves the worker posting
// into a not-found response that looks, from the queue's side, like an outcome
// nobody recorded.
//
// Both sides are read as text and matched shape by shape: a template segment in
// the worker's url stands where a `:name` stands in the route. QC-007 — where a
// value is written twice, assert agreement rather than forbid it.

const DEFAULT_PREFIX = "/v1/internal/";

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patterns(prefix) {
  const literal = escape(prefix);
  return {
    route: new RegExp(`path:\\s*"(${literal}[^"]*)"`, "g"),
    worker: new RegExp("`(?:\\$\\{[A-Za-z0-9_.]+\\})?(" + literal + "[^`]*)`", "g"),
  };
}

function collect(source, pattern) {
  const found = new Set();
  pattern.lastIndex = 0;
  let match = pattern.exec(source);
  while (match !== null) {
    found.add(match[1]);
    match = pattern.exec(source);
  }
  return found;
}

/** A route's `:name` and a worker's `${expression}` are both one segment. */
function normalise(path) {
  return path
    .split("/")
    .map((segment) => (segment.startsWith(":") || /^\$\{.*\}$/.test(segment) ? ":" : segment))
    .join("/");
}

export function declaredInternalRoutes(triggerSources, options = {}) {
  const { route } = patterns(options.prefix ?? DEFAULT_PREFIX);
  const found = new Set();
  for (const source of triggerSources) {
    for (const path of collect(source, route)) found.add(normalise(path));
  }
  return found;
}

export function calledInternalRoutes(workerSources, options = {}) {
  const { worker } = patterns(options.prefix ?? DEFAULT_PREFIX);
  const found = new Map();
  for (const { path, source } of workerSources) {
    for (const called of collect(source, worker)) {
      found.set(normalise(called), path);
    }
  }
  return found;
}

/** @returns {{path: string, rule: string, detail: string}[]} */
export function checkInternalRoutes(declared, called) {
  const problems = [];
  for (const [route, where] of called) {
    if (!declared.has(route)) {
      problems.push({
        path: where,
        rule: "unserved-internal-route",
        detail: `posts to '${route.replace(/\/:/g, "/{id}")}', which no api route declares`,
      });
    }
  }
  return problems;
}
