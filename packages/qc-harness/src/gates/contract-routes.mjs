// The composed contract lists the operations the api offers; a feature's trigger lists the routes it
// serves. Nothing ties the two, so a route can ship with no operation and an operation with no route.
// Both sides are read and matched by method and path shape: a trigger's `:name` and a contract's
// `{name}` are each one segment. QC-007 -- where a value is written twice, assert agreement.

const ROUTE = /method:\s*["'`]([A-Za-z]+)["'`]\s*,\s*path:\s*["'`]([^"'`]+)["'`]/g;

/** A route's `:name` and a contract's `{name}` are both one segment. */
function shape(path) {
  return path
    .split("/")
    .map((segment) => (segment.startsWith(":") || /^\{.*\}$/.test(segment) ? ":" : segment))
    .join("/");
}

const keyOf = ({ method, path }) => `${method.toLowerCase()} ${shape(path)}`;
const nameOf = ({ method, path }) => `${method.toLowerCase()} ${path}`;

/** @returns {{method: string, path: string, file: string}[]} every route the triggers declare */
export function declaredTriggerRoutes(triggerSources) {
  const routes = [];
  for (const { path: file, source } of triggerSources) {
    for (const [, method, path] of source.matchAll(ROUTE)) routes.push({ method: method.toLowerCase(), path, file });
  }
  return routes;
}

/**
 * @param {{method: string, path: string, file: string}[]} routes
 * @param {{method: string, path: string}[]} operations
 * @param {{contract: string, exempt: {method: string, path: string, why: string}[], config?: string}} options
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkContractRoutes(routes, operations, { contract, exempt, config = "qc.config.json" }) {
  const served = new Set(routes.map(keyOf));
  const offered = new Set(operations.map(keyOf));
  const exempted = new Set(exempt.map(keyOf));
  const problems = [];
  const used = new Set();
  for (const route of routes) {
    const key = keyOf(route);
    if (offered.has(key)) continue;
    if (exempted.has(key)) used.add(key);
    else problems.push({ path: route.file, rule: "route-not-in-contract", detail: `serves '${nameOf(route)}', which ${contract} does not list` });
  }
  for (const operation of operations) {
    const key = keyOf(operation);
    if (served.has(key)) continue;
    if (exempted.has(key)) used.add(key);
    else problems.push({ path: contract, rule: "operation-not-served", detail: `lists '${nameOf(operation)}', which no feature trigger serves` });
  }
  for (const entry of exempt) {
    if (used.has(keyOf(entry))) continue;
    problems.push({ path: config, rule: "stale-route-exemption", detail: `exempts '${nameOf(entry)}', which is neither a route the contract omits nor an operation no trigger serves` });
  }
  return problems;
}
