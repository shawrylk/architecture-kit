import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkPlainLanguage, markdownProse, sentences, stripInline } from "./plain-language.mjs";

const doc = (contents) => [{ path: "docs/a.md", contents }];
const only = (problems, rule) => problems.filter((problem) => problem.rule === rule);

test("a short active sentence in the approved words passes", () => {
  const problems = checkPlainLanguage(doc("The gate reads the file and names the line.\n"));
  assert.deepEqual(problems, []);
});

test("a description over the word limit fails and names the count", () => {
  const long = `The gate counts ${"words ".repeat(30)}here.`;
  const problems = only(checkPlainLanguage(doc(long)), "sentence-too-long");
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /34 words in a description, max 25/);
});

test("a list item takes the shorter instruction limit", () => {
  const item = `- Run the ${"step ".repeat(20)}now.\n`;
  const problems = only(checkPlainLanguage(doc(item)), "sentence-too-long");
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /in an instruction, max 20/);
});

test("a paragraph over the sentence limit fails once, at its first line", () => {
  const problems = only(checkPlainLanguage(doc("One. Two. Three. Four. Five. Six. Seven.\n")), "paragraph-too-long");
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /line 1: 7 sentences, max 6/);
});

test("an unapproved word fails and names the word that replaces it", () => {
  const problems = only(checkPlainLanguage(doc("The runner will utilize the cache.\n")), "unapproved-word");
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /"utilize" is not the approved word. Write "use"/);
});

test("a word that carries nothing is reported as a deletion", () => {
  const problems = only(checkPlainLanguage(doc("This is simply the cache.\n")), "unapproved-word");
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /Delete it/);
});

test("a multi-word phrase is found the same way a word is", () => {
  const problems = only(checkPlainLanguage(doc("Run the check in order to find the line.\n")), "unapproved-word");
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /"in order to"/);
});

test("a repository removes a word the kit ships by setting it to null", () => {
  const problems = checkPlainLanguage(doc("The runner will utilize the cache.\n"), { replace: { utilize: null } });
  assert.deepEqual(only(problems, "unapproved-word"), []);
});

test("the passive voice fails and quotes the phrase that hides the actor", () => {
  const problems = only(checkPlainLanguage(doc("The file is read by the gate.\n")), "passive-voice");
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /"is read" is passive/);
});

test("the passive check is switchable", () => {
  const problems = checkPlainLanguage(doc("The file is read by the gate.\n"), { passive: false });
  assert.deepEqual(only(problems, "passive-voice"), []);
});

test("a title-case heading fails and names each word to lowercase", () => {
  const problems = only(checkPlainLanguage(doc("## How The Gate Reads\n")), "heading-case");
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /"The", "Gate", "Reads"/);
});

test("a heading keeps the capital on a name", () => {
  const problems = checkPlainLanguage(doc("## Working with TypeScript\n"));
  assert.deepEqual(only(problems, "heading-case"), []);
});

test("a repository names its own proper nouns", () => {
  const problems = checkPlainLanguage(doc("## Working with Fastly\n"), { properNouns: ["Fastly"] });
  assert.deepEqual(only(problems, "heading-case"), []);
});

test("link text that says where to click, not what is there, fails", () => {
  const problems = only(checkPlainLanguage(doc("Read [here](https://example.com) first.\n")), "link-text");
  assert.equal(problems.length, 1);
});

test("a fenced block is code, not prose", () => {
  const contents = `\`\`\`js\n// The runner will utilize ${"the cache ".repeat(20)}now.\n\`\`\`\n`;
  assert.deepEqual(checkPlainLanguage(doc(contents)), []);
});

test("an inline code span counts as neither a word nor a capital", () => {
  assert.deepEqual(checkPlainLanguage(doc("## Reading `Utilize.json`\n")), []);
});

test("a table row is data, not a sentence", () => {
  const row = `| ${"word ".repeat(40)} | x |\n`;
  assert.deepEqual(checkPlainLanguage(doc(row)), []);
});

test("front matter is metadata, not prose", () => {
  assert.deepEqual(checkPlainLanguage(doc("---\ndescription: utilize the cache\n---\n\nThe gate runs.\n")), []);
});

test("a source file is read through its comments, not its code", () => {
  const contents = '// The runner will utilize the cache\nconst label = "utilize";\n';
  const problems = only(checkPlainLanguage([{ path: "src/a.mjs", contents }]), "unapproved-word");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].detail.startsWith("line 1:"), true);
});

test("an allowed path is not read", () => {
  const files = [{ path: "docs/legacy.md", contents: "The runner will utilize the cache.\n" }];
  assert.deepEqual(checkPlainLanguage(files, { allow: ["docs/legacy.md"] }), []);
});

test("a stop inside an identifier does not end a sentence", () => {
  assert.deepEqual(sentences("The file config.json holds the roots."), ["The file config.json holds the roots."]);
});

test("stripInline removes a link target and keeps its text", () => {
  assert.equal(stripInline("Read [the guide](https://example.com) now.").includes("example.com"), false);
});

test("markdownProse labels a heading, an item and a paragraph line", () => {
  const units = markdownProse("# Title\n\n- Step one\n\nA line.\n");
  assert.deepEqual(units.map((unit) => unit.kind), ["heading", "item", "text"]);
});

test("a hard-wrapped sentence is counted once, not once a line", () => {
  const wrapped = `The gate counts ${"words ".repeat(15)}\nand then it counts ${"more ".repeat(15)}here.\n`;
  const problems = only(checkPlainLanguage(doc(wrapped)), "sentence-too-long");
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /line 1: 3[0-9] words/);
});

test("a blank line ends a paragraph, so two short ones do not join", () => {
  const problems = checkPlainLanguage(doc("One. Two. Three.\n\nFour. Five. Six.\n"));
  assert.deepEqual(only(problems, "paragraph-too-long"), []);
});

test("a state that reads as a state is not reported as passive", () => {
  const problems = checkPlainLanguage(doc("The branch is uncommitted.\n"));
  assert.deepEqual(only(problems, "passive-voice"), []);
});

test("a numbered heading keeps the capital on its first real word", () => {
  const problems = checkPlainLanguage(doc("### 1. Set up a repository\n"));
  assert.deepEqual(only(problems, "heading-case"), []);
});

test("an em dash fails, because it holds two sentences in one", () => {
  const problems = only(checkPlainLanguage(doc("The gate reads the file — it names the line.\n")), "em-dash");
  assert.equal(problems.length, 1);
});

test("a spaced double hyphen reads as the same dash", () => {
  const problems = only(checkPlainLanguage(doc("The gate reads the file -- it names the line.\n")), "em-dash");
  assert.equal(problems.length, 1);
});

test("a hyphenated word is not a dash", () => {
  assert.deepEqual(only(checkPlainLanguage(doc("The gate is well-known.\n")), "em-dash"), []);
});

test("a semicolon fails", () => {
  const problems = only(checkPlainLanguage(doc("The gate reads it; the runner prints it.\n")), "semicolon");
  assert.equal(problems.length, 1);
});

test("the punctuation check is switchable", () => {
  const problems = checkPlainLanguage(doc("The gate reads it; it prints it.\n"), { punctuation: false });
  assert.deepEqual(only(problems, "semicolon"), []);
});

test("a dash inside code is not prose", () => {
  assert.deepEqual(checkPlainLanguage(doc("Run `qc check --fix` now.\n")), []);
});
