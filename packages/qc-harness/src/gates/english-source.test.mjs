import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkEnglishSource, checkTranslationPairs, commentLines } from "./english-source.mjs";

const file = (path, contents) => [{ path, contents }];

test("an English comment beside Japanese data passes", () => {
  const files = file("backend/src/features/delivery/shared/guards.ts", 'const agency = "国土交通省"; // The issuing ministry.');
  assert.deepEqual(checkEnglishSource(files, { allowNonEnglish: ["backend/src/features/delivery/**"] }), []);
});

test("a Japanese comment fails wherever it is, even in a declared path", () => {
  const files = file("frontend/src/platform/i18n/dictionaries/ja.ts", "// 図面 keeps its card for the sheet preview.");
  const problems = checkEnglishSource(files, { allowNonEnglish: ["frontend/src/platform/i18n/**"] });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "english-comment");
  assert.match(problems[0].detail, /line 1/);
});

test("a Japanese doc comment fails, since JSDoc is prose too", () => {
  const files = file("frontend/src/f/gallery.tsx", "/** What a row of 図面 is. */\nexport const rows = [];");
  assert.equal(checkEnglishSource(files)[0].rule, "english-comment");
});

test("Japanese in an undeclared string is a finding that names the config key", () => {
  const files = file("backend/src/features/x/trigger.ts", 'export const label = "検査対象";');
  const [problem] = checkEnglishSource(files);
  assert.equal(problem.rule, "english-source");
  assert.match(problem.detail, /language\.allowNonEnglish/);
});

test("Japanese in a declared string passes, because data is not prose", () => {
  const files = file("frontend/src/platform/i18n/dictionaries/ja.json", '{"inspection":"検査"}');
  assert.deepEqual(checkEnglishSource(files, { allowNonEnglish: ["frontend/src/platform/i18n/dictionaries/**"] }), []);
});

test("a purely English file is never inspected line by line", () => {
  assert.deepEqual(checkEnglishSource(file("a/b.ts", "// ordinary\nexport const x = 1;")), []);
});

test("a block comment's interior counts as comment, and code after it does not", () => {
  const lines = commentLines("/*\n * 検査\n */\nconst x = 1;");
  assert.deepEqual(lines.map((entry) => entry.line), [1, 2, 3]);
});

test("a declared translation without its English variant fails", () => {
  const paths = ["src/i18n/ja.json", "src/i18n/vi.json"];
  const problems = checkTranslationPairs(paths, [{ pattern: "**/i18n/*.json", english: "en.json" }]);
  assert.equal(problems.length, 2);
  assert.match(problems[0].detail, /src\/i18n\/en\.json/);
});

test("any language is welcome once English is beside it", () => {
  const paths = ["src/i18n/ja.json", "src/i18n/vi.json", "src/i18n/en.json"];
  assert.deepEqual(checkTranslationPairs(paths, [{ pattern: "**/i18n/*.json", english: "en.json" }]), []);
});

test("an empty script list is a named config error, not a gate that matches nothing", () => {
  assert.throws(() => checkEnglishSource(file("a.ts", "x"), { scripts: [] }), /language\.scripts/);
});

test("a markdown heading is not a comment, so a declared document is not scanned line by line", () => {
  const files = [{ path: "docs/design-tokens.md", contents: "# ピンのステータス色\n\nbody\n" }];
  assert.deepEqual(checkEnglishSource(files, { allowNonEnglish: ["docs/design-tokens.md"] }), []);
});

test("an undeclared markdown document with Japanese still fails, at file level", () => {
  const files = [{ path: "docs/notes.md", contents: "# 検査\n" }];
  assert.equal(checkEnglishSource(files)[0].rule, "english-source");
});

test("a legacy entry allows the file it names", () => {
  const files = [{ path: "a/old.tsx", contents: 'const label = "検査";' }];
  assert.deepEqual(checkEnglishSource(files, { legacyNonEnglish: ["a/old.tsx"] }), []);
});

test("a legacy entry for a file that is already clean fails, so the list can only shrink", () => {
  const files = [{ path: "a/old.tsx", contents: 'const label = "Inspection";' }];
  const [problem] = checkEnglishSource(files, { legacyNonEnglish: ["a/old.tsx"] });
  assert.equal(problem.rule, "stale-legacy-entry");
});
