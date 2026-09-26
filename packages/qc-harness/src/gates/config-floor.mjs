// The kit ships every rule on. A repository may switch one off -- some do not apply to its shape --
// but not silently: the switch names a decision id, and the citations gate resolves that id against
// the register. Turning a rule off becomes a reviewed act with a reason attached, which is the
// difference between adopting a standard and negotiating with it.

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

/** Every shipped check this repository has switched off, by kind. A hook's exemption key is `hooks.<name>`. */
function offByKind(shipped, configured) {
  return {
    gates: switchedOff(shipped.gates ?? {}, configured.gates ?? {}),
    rules: switchedOff(shipped.rules ?? {}, configured.rules ?? {}),
    hooks: weakenedHooks(shipped.hooks?.required, configured.hooks?.required).map((name) => `hooks.${name}`),
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

  const off = offByKind(shipped, configured);
  for (const kind of ["gates", "rules", "hooks"]) {
    for (const name of off[kind]) {
      const shown = kind === "hooks" ? name : `${kind}.${name}`;
      const cited = exemptions[name];
      if (cited === undefined) {
        problems.push({
          path: "qc.config.json",
          rule: "unexempted-opt-out",
          detail:
            `${shown} is switched off, and the kit ships it on. Name the decision that says ` +
            `why under floor.exemptions, or "${OFF_BY_DESIGN}" when the rule cannot apply to this repository's shape.`,
        });
        continue;
      }
      if (cited !== OFF_BY_DESIGN && !pattern.test(cited)) {
        problems.push({
          path: "qc.config.json",
          rule: "unexempted-opt-out",
          detail: `floor.exemptions.${name} is "${cited}", which is neither a decision id nor "${OFF_BY_DESIGN}".`,
        });
      }
    }
  }
  // An exemption for something that is not off is a stale reason nobody will notice going wrong.
  const inForce = new Set([...off.gates, ...off.rules, ...off.hooks]);
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
