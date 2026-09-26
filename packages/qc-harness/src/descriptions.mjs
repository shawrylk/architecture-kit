// What each gate enforces, beside the gate, so a consumer generates its map instead of writing one.

export const gateDescriptions = Object.freeze({
  "eight-blocks": "A feature keeps the anatomy it declares, and no block or slice is empty",
  citations: "Every cited id and doc path resolves, and nothing references another repository",
  "registry-agreement": "A value written twice agrees with the registry that owns it",
  "registry-readers": "Every reader a registry entry names exists and names the entry",
  "sql-identifiers": "A query names a column a migration declares, and only its own feature's tables",
  "tenant-predicate": "Every statement on a business table filters on the tenant",
  "claimed-requirements": "A requirement a route claims names the test that proves it",
  "public-routes": "The edge lets through exactly the routes the api serves without a session",
  "internal-routes": "Every path a worker posts to is a route the api serves",
  "headless-sagas": "The block that carries a workflow runs without a view layer",
  "saga-tests": "Every workflow is named by a test that imports no view module",
  "feature-cli": "Every feature is drivable headless through a published command block, with no server",
  "gate-tests": "A repository's own gates each ship a case that must fail",
  "audit-append-only": "The audit log has no update or delete path in any repository",
  "frontend-boundaries": "Platform remains a thin substrate and never holds feature domain logic or junk drawer directories",
  "test-mirror": "Tests mirror src paths 1:1 in every configured root, and no test is orphaned without a source file",
  "enforcement-map": "Every rule names a check, and every check the kit runs is named",
  "config-floor": "A check the kit ships on is switched off only by naming the decision that says why",
  "english-source": "Comments, docs and rules are English; another language is data, declared beside its English variant",
  "adr-format": "Every decision record carries its cost and the alternatives it rejected, not just its claim",
  "comment-style": "A comment under infra/ is one line of why, never a paragraph, a banner or code",
});

/** The gates a consumer can switch on, so a caller need not import the defaults to find out. */
export function describedGates() {
  return Object.keys(gateDescriptions);
}
