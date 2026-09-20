// A route names the requirements it satisfies. `docs/migration/plan.md` makes
// "every claimed id resolves, with `tests` filled" part of every unit's
// definition of done — the only item on that list a person had to check by
// reading. This checks it.
//
// It asserts a claim is backed, not that the backing is good. Whether the named
// test proves the statement is what review is for.

const DEFAULT_KEY = "req";
const DEFAULT_ID = "REQ-[A-Z]{3}-\\d{3}";

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every requirement id a feature's routes claim. */
export function claimedIds(source, options = {}) {
  const key = escape(options.key ?? DEFAULT_KEY);
  const array = new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`, "g");
  const id = new RegExp(options.id ?? DEFAULT_ID, "g");

  const claimed = new Set();
  let match = array.exec(source);
  while (match !== null) {
    for (const found of match[1].match(id) ?? []) claimed.add(found);
    match = array.exec(source);
  }
  return claimed;
}

/**
 * @param {{path: string, source: string}[]} triggers
 * @param {Map<string, string[]>} tests requirement id to the tests it names
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkClaimedRequirements(triggers, tests, options = {}) {
  const problems = [];
  for (const { path, source } of triggers) {
    for (const id of [...claimedIds(source, options)].sort()) {
      const named = tests.get(id);
      if (named === undefined) {
        problems.push({ path, rule: "unregistered-requirement", detail: `${id} is claimed but not registered` });
      } else if (named.length === 0) {
        problems.push({
          path,
          rule: "unproven-requirement",
          detail: `${id} is claimed by a route and names no test`,
        });
      }
    }
  }
  return problems;
}
