import assert from "node:assert/strict";
import test from "node:test";
import { redactOutput, postBody } from "./output-redaction.mjs";

const label = "Written by an AI agent with architecture-kit.";
const pemHeader = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");
const secrets = [
  `AKIA${"A".repeat(16)}`,
  `ASIA${"B".repeat(16)}`,
  `${["aws_secret", "_access_key"].join("")} = ${"a".repeat(40)}`,
  ...["p", "o", "u", "s", "r"].map((kind) => `gh${kind}_${"a".repeat(40)}`),
  `github_pat_${"b".repeat(50)}`,
  `${pemHeader}\nkey material\n-----END RSA PRIVATE KEY-----`,
  `sk-ant-${"c".repeat(30)}`,
  ...["a", "b", "p", "r", "s"].map((kind) => `xox${kind}-${"d".repeat(20)}`),
  `npm_${"e".repeat(36)}`,
];

test("redaction replaces every shared secret shape and each repeated occurrence", () => {
  for (const secret of secrets) {
    assert.equal(redactOutput(`Before (${secret}), after: ${secret}.`), "Before ([REDACTED]), after: [REDACTED].");
  }
});

test("redaction removes complete PEM blocks across lines and on one line", () => {
  for (const separator of ["\n", "\r\n", " ", ""]) {
    const key = `${pemHeader}${separator}MIIEowIBAAKCAQEA7b+/abc=${separator}-----END RSA PRIVATE KEY-----`;
    assert.equal(redactOutput(`Before ${key} after`), "Before [REDACTED] after");
    assert.equal(redactOutput(`${key}\n${key}`), "[REDACTED]\n[REDACTED]");
  }
});

test("redaction consumes an unterminated PEM block through the end of the text", () => {
  for (const kind of ["", "RSA ", "EC ", "ENCRYPTED "]) {
    const key = `-----BEGIN ${kind}PRIVATE KEY-----\nMIIEowIBAAKCAQEA7b+/abc=\ntrailing text`;
    assert.equal(redactOutput(`Before ${key}`), "Before [REDACTED]");
  }
  assert.equal(redactOutput(`${pemHeader}\nmaterial\n-----END EC PRIVATE KEY-----\nmore`), "[REDACTED]");
});

test("redaction finds PEM headers after earlier dashes and adjacent word characters", () => {
  for (const prefix of ["out: ----- x ", "key", "7", "_"]) {
    const key = `${pemHeader}\nmaterial\n-----END RSA PRIVATE KEY-----`;
    assert.equal(redactOutput(`${prefix}${key} after`), `${prefix}[REDACTED] after`);
    assert.equal(redactOutput(`${prefix}${pemHeader}`), `${prefix}[REDACTED]`);
  }
});

test("redaction removes AWS secret assignments including the complete value", () => {
  const value = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/");
  assert.equal(value.length, 40);
  const assignment = `aws_secret_access_key = ${value}`;
  assert.equal(redactOutput(`Before ${assignment}\n${assignment}\nafter`), "Before [REDACTED]\n[REDACTED]\nafter");
  assert.equal(redactOutput(`qc-allow-secret ${assignment}`), "qc-allow-secret [REDACTED]");
});

test("redaction covers prefixed AWS names, CLI whitespace, and arrow assignments", () => {
  const value = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  for (const [assignment, expected] of [
    [`TF_VAR_aws_secret_access_key=${value}`, "TF_VAR_[REDACTED]"],
    [`PROD_AWS_SECRET_ACCESS_KEY=${value}`, "PROD_[REDACTED]"],
    [`aws configure set aws_secret_access_key ${value}`, "aws configure set [REDACTED]"],
    [`"aws_secret_access_key" => "${value}"`, '"[REDACTED]"'],
  ]) {
    assert.equal(redactOutput(`Before ${assignment}\n${assignment}\nafter`), `Before ${expected}\n${expected}\nafter`);
    assert.equal(redactOutput(`qc-allow-secret ${assignment}`), `qc-allow-secret ${expected}`);
  }
});

test("redaction preserves public text and ignores commit allow directives", () => {
  const publicText = "# Public title\n\nRefs #195; ordinary-code_identifier.\r\n";
  assert.equal(redactOutput(publicText), publicText);
  assert.equal(redactOutput(`qc-allow-secret ${secrets[3]}\n${secrets[0]}`), "qc-allow-secret [REDACTED]\n[REDACTED]");
  assert.equal(redactOutput(`qc-allow-secret${secrets[3]}`), "qc-allow-secret[REDACTED]");
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
  for (const body of [`Body\n\n${label}`, `Body\r\n${label}\r\n`, `Body\n${label}\n${label}`]) {
    const posted = postBody(body);
    assert.ok(posted.endsWith(label));
    assert.equal(posted.split(label).length - 1, 1);
    assert.equal(postBody(posted), posted);
  }
});

test("attribution preserves quoted and leading labels and strips only trailing label lines", () => {
  for (const body of [`Quote: "${label}" was here`, `${label}\nBody`, `Body ${label}`, `${label} extra`]) {
    const posted = `${body}\n\n${label}`;
    assert.equal(postBody(body), posted);
    assert.equal(postBody(`${body}\r\n${label}\r\n\r\n${label}\r\n`), posted);
    assert.equal(postBody(posted), posted);
  }
  assert.equal(postBody(`${label}\r\n${label}\r\n`), label);
});
