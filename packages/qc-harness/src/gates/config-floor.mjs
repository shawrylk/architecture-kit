// The kit ships every rule on. A repository may switch one off -- some do not apply to its shape --
// but not silently: the switch names a decision id, and the citations gate resolves that id against
// the register. Turning a rule off becomes a reviewed act with a reason attached, which is the
// difference between adopting a standard and negotiating with it.

import { requiredHooks } from "../config.mjs";

const OFF_BY_DESIGN = "off-by-design";

/** @returns every check the kit ships that this repository has switched off. */
export function switchedOff(shipped, configured) {
  return Object.keys(shipped)
    .filter((name) => shipped[name] === true)
    .filter((name) => configured[name] === false)
    .sort();
}

/** @returns each hook whose required calls lack one the kit ships. */
export function weakenedHooks(shipped = {}, configured = {}) {
  return Object.keys(shipped)
    .filter((name) => shipped[name].some((call) => !(configured[name] ?? []).includes(call)))
    .sort();
}

/** @returns each shipped helper the configured list lacks. An entry matches on `module` and `name`. */
export function droppedHelpers(shipped = [], configured = []) {
  return shipped.filter((helper) => !configured.some((kept) => kept.module === helper.module && kept.name === helper.name));
}

/** Every shipped check this repository has switched off, by kind. A hook's exemption key is `hooks.<name>`. */
function offByKind(shipped, configured) {
  const shippedHooks = requiredHooks({ ...shipped, commitMessage: configured.commitMessage });
  return {
    gates: switchedOff(shipped.gates ?? {}, configured.gates ?? {}),
    rules: switchedOff(shipped.rules ?? {}, configured.rules ?? {}),
    hooks: weakenedHooks(shippedHooks, configured.hooks?.required).map((name) => `hooks.${name}`),
  };
}

/**
 * @param {{gates: object, rules: object}} shipped   the kit's own defaults
 * @param {{gates: object, rules: object}} configured this repository's resolved config
 * @param {{exemptions?: Record<string,string>, pattern?: RegExp}} [options]
 */
export function checkConfigFloor(shipped, configured, options = {}) {
  const exemptions = options.exemptions ?? {};
  const pattern = options.pattern ?? /^[A-Z]{2,5}-\d{3,4}$/;
  const problems = [];

  // A missing exemption is `unexempted`; a cited one must be a decision id or "off-by-design".
  const judge = (key, rule, unexempted) => {
    const cited = exemptions[key];
    if (cited === undefined) problems.push({ path: "qc.config.json", rule, detail: unexempted });
    else if (cited !== OFF_BY_DESIGN && !pattern.test(cited)) {
      problems.push({
        path: "qc.config.json",
        rule,
        detail: `floor.exemptions.${key} is "${cited}", which is neither a decision id nor "${OFF_BY_DESIGN}".`,
      });
    }
  };

  const off = offByKind(shipped, configured);
  for (const kind of ["gates", "rules", "hooks"]) {
    for (const name of off[kind]) {
      const shown = kind === "hooks" ? name : `${kind}.${name}`;
      judge(
        name,
        "unexempted-opt-out",
        `${shown} is switched off, and the kit ships it on. Name the decision that says ` +
          `why under floor.exemptions, or "${OFF_BY_DESIGN}" when the rule cannot apply to this repository's shape.`,
      );
    }
  }
  // A kit default helper named in neither list is the same opt-out. `qc check` reads the two lists as one.
  const { exemptHelpers = [], extraExemptHelpers = [] } = configured.tenantPredicate ?? {};
  const dropped = droppedHelpers(shipped.tenantPredicate?.exemptHelpers, [...exemptHelpers, ...extraExemptHelpers]);
  for (const { module, name } of dropped) {
    judge(
      `tenantPredicate.${name}`,
      "dropped-default-helper",
      `The kit default ${name} (${module}) is in neither exemptHelpers nor extraExemptHelpers under tenantPredicate. Keep it in exemptHelpers, and put a helper you add in ` +
        `extraExemptHelpers. To drop it on purpose, name the decision that says why under ` +
        `floor.exemptions.tenantPredicate.${name}, or "${OFF_BY_DESIGN}".`,
    );
  }
  // An exemption for something that is not off is a stale reason nobody will notice going wrong.
  const inForce = new Set([...off.gates, ...off.rules, ...off.hooks, ...dropped.map(({ name }) => `tenantPredicate.${name}`)]);
  for (const name of Object.keys(exemptions).sort()) {
    if (!inForce.has(name)) {
      problems.push({
        path: "qc.config.json",
        rule: "stale-exemption",
        detail: `floor.exemptions.${name} exempts a check that is in force. Delete the exemption.`,
      });
    }
  }
  return problems;
}

/** The ids an exemption block cites, for the citations gate to resolve. */
export function exemptionIds(exemptions = {}) {
  return [...new Set(Object.values(exemptions).filter((value) => value !== OFF_BY_DESIGN))];
}
