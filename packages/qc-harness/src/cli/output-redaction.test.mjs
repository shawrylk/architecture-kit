import assert from "node:assert/strict";
import test from "node:test";
import { redactOutput, postBody } from "./output-redaction.mjs";

const label = "Written by an AI agent with architecture-kit.";
const secrets = [
  `AKIA${"A".repeat(16)}`,
  `ASIA${"B".repeat(16)}`,
  ["aws_secret", "_access_key"].join(""),
  ...["p", "o", "u", "s", "r"].map((kind) => `gh${kind}_${"a".repeat(40)}`),
  `github_pat_${"b".repeat(50)}`,
  ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" "),
  `sk-ant-${"c".repeat(30)}`,
  ...["a", "b", "p", "r", "s"].map((kind) => `xox${kind}-${"d".repeat(20)}`),
  `npm_${"e".repeat(36)}`,
];

test("redaction replaces every shared secret shape and each repeated occurrence", () => {
  for (const secret of secrets) {
    assert.equal(redactOutput(`Before (${secret}), after: ${secret}.`), "Before ([REDACTED]), after: [REDACTED].");
  }
});

test("redaction preserves public text and ignores commit allow directives", () => {
  const publicText = "# Public title\n\nRefs #195; ordinary-code_identifier.\r\n";
  assert.equal(redactOutput(publicText), publicText);
  assert.equal(redactOutput(`qc-allow-secret ${secrets[3]}\n${secrets[0]}`), "qc-allow-secret [REDACTED]\n[REDACTED]");
  assert.equal(redactOutput(`qc-allow-secret${secrets[3]}`), "[REDACTED]");
  assert.equal(redactOutput(""), "");
});

test("bodies redact secrets and append the AI label by default", () => {
  assert.equal(postBody(`Body: ${secrets[3]}`), `Body: [REDACTED]\n\n${label}`);
  assert.equal(postBody(""), label);
});

test("disabling attribution keeps redaction enabled", () => {
  assert.equal(postBody(`Body: ${secrets[3]}`, { post: { aiLabel: false } }), "Body: [REDACTED]");
});

test("attribution occurs once and ends the body across repeated calls and line endings", () => {
  for (const body of [`Body\n\n${label}`, `Body\r\n${label}\r\n`, `${label}\nBody`, `Body\n${label}\n${label}`]) {
    const posted = postBody(body);
    assert.ok(posted.endsWith(label));
    assert.equal(posted.split(label).length - 1, 1);
    assert.equal(postBody(posted), posted);
  }
});
