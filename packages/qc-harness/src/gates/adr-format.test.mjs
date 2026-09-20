import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkAdrFormat, relatedIds, sections, wordCount } from "./adr-format.mjs";

const SECTIONS = ["Context", "What this costs"];
const prose = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const doc = (body) => `# ADR-0031 — Keyset pagination everywhere\n\n${body}`;
const full = doc(`## Context\n\n${prose(20)}\n\n## What this costs\n\n${prose(20)}\n`);

test("a complete ADR passes", () => {
  assert.deepEqual(checkAdrFormat([{ path: "a.md", contents: full }], { sections: SECTIONS }), []);
});

test("a missing section is named", () => {
  const [problem] = checkAdrFormat([{ path: "a.md", contents: doc(`## Context\n\n${prose(20)}\n`) }], { sections: SECTIONS });
  assert.equal(problem.rule, "adr-section-missing");
  assert.match(problem.detail, /What this costs/);
});

test("a present but empty section fails, which is the usual way a template is defeated", () => {
  const thin = doc(`## Context\n\n${prose(20)}\n\n## What this costs\n\nNone.\n`);
  const [problem] = checkAdrFormat([{ path: "a.md", contents: thin }], { sections: SECTIONS });
  assert.equal(problem.rule, "adr-section-empty");
  assert.match(problem.detail, /say what it cost, or say there was no cost and why/);
});

test("the template's own guidance comments do not count as prose", () => {
  const commented = doc(`## Context\n\n${prose(20)}\n\n## What this costs\n\n<!-- ${prose(40)} -->\n`);
  assert.equal(checkAdrFormat([{ path: "a.md", contents: commented }], { sections: SECTIONS })[0].rule, "adr-section-empty");
});

test("a title without a decision id fails", () => {
  const untitled = `# Keyset pagination\n\n## Context\n\n${prose(20)}\n\n## What this costs\n\n${prose(20)}\n`;
  assert.equal(checkAdrFormat([{ path: "a.md", contents: untitled }], { sections: SECTIONS })[0].rule, "adr-title");
});

test("a subheading under an alternative does not open a new section", () => {
  const withSub = doc(`## Context\n\n${prose(20)}\n\n## What this costs\n\n### Offset paging\n\n${prose(20)}\n`);
  assert.deepEqual(sections(withSub).map((s) => s.heading), ["Context", "What this costs"]);
  assert.deepEqual(checkAdrFormat([{ path: "a.md", contents: withSub }], { sections: SECTIONS }), []);
});

test("related ids are collected for the citations gate to resolve", () => {
  const related = `# ADR-0031 — x\n\n## Related decisions\n\nADR-0028 owns the cursor. QC-007 names the check. ADR-0028 again.\n`;
  assert.deepEqual(relatedIds(related), ["ADR-0028", "QC-007"]);
});

test("a table row is structure, not prose", () => {
  assert.equal(wordCount("| Status | accepted |\n"), 0);
});

test("an empty required-section list is a named config error", () => {
  assert.throws(() => checkAdrFormat([{ path: "a.md", contents: full }], { sections: [] }), /adr\.sections/);
});
