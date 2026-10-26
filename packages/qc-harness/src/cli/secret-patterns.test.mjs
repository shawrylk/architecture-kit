import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findSecrets } from "./secret-patterns.mjs";
import { redactOutput } from "./output-redaction.mjs";

const samples = [
  ["aws-access-key", `AKIA${"A".repeat(16)}`],
  ["aws-access-key", `ASIA${"B".repeat(16)}`],
  ["aws-secret-key", `AWS_SECRET_ACCESS_KEY=${"a".repeat(40)}`],
  ...[
    ["TF_VAR_aws_secret_access_key=", "TF_VAR_[REDACTED]"],
    ["PROD_AWS_SECRET_ACCESS_KEY=", "PROD_[REDACTED]"],
    ["aws configure set aws_secret_access_key ", "aws configure set [REDACTED]"],
    ['"aws_secret_access_key" => "', '"[REDACTED]'],
  ].map(([prefix, redacted]) => ["aws-secret-key", `${prefix}wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, redacted]),
  ...["p", "o", "u", "s", "r"].map((kind) => ["github-token", `gh${kind}_${"a".repeat(36)}`]),
  ["github-pat", `github_pat_${"a".repeat(40)}`],
  ["private-key", "-----BEGIN RSA PRIVATE KEY-----"], // qc-allow-secret
  ["private-key", "-----BEGIN PRIVATE KEY-----"], // qc-allow-secret
  ["anthropic-key", `sk-ant-${"a".repeat(20)}`],
  ...["a", "b", "p", "r", "s"].map((kind) => ["slack-token", `xox${kind}-${"a".repeat(10)}`]),
  ["npm-token", `npm_${"a".repeat(36)}`],
];

for (const [rule, sample, redacted = "[REDACTED]"] of samples) {
  test(`detects ${rule}: ${sample.slice(0, 8)}`, () => {
    assert.ok(findSecrets(`token=${sample}`).includes(rule));
    assert.deepEqual(findSecrets(`token=${sample} # qc-allow-secret`), []);
    assert.equal(redactOutput(sample), redacted, rule);
    const complete = rule === "private-key" ? `${sample}\nmaterial\n${sample.replace("BEGIN", "END")}` : sample;
    assert.equal(redactOutput(`${complete}\n${complete} qc-allow-secret`), `${redacted}\n${redacted} qc-allow-secret`, rule);
  });
}

test("ordinary text and short token prefixes pass", () => {
  assert.deepEqual(findSecrets("const token = 'ghp_short'; // AWS_ACCESS_KEY_ID"), []);
});

test("AWS names and workflow references pass without a literal 40-character value", () => {
  for (const line of [
    "AWS_SECRET_ACCESS_KEY",
    'AWS_SECRET_ACCESS_KEY: "aws-secret"',
    'aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}',
    'AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}',
    `AWS_SECRET_ACCESS_KEY=${"a".repeat(39)}`,
    `AWS_SECRET_ACCESS_KEY=${"a".repeat(41)}`,
  ]) assert.deepEqual(findSecrets(line), [], line);
});

test("AWS literal assignments cover the value, quotes, both separators, and case", () => {
  for (const name of ["AWS_SECRET_ACCESS_KEY", "aws_secret_access_key", "aws-secret-access-key"]) {
    for (const separator of ["=", ":", "=>", " ", "\t"]) {
      for (const quote of ["", "'", '"']) {
        const line = `${quote}${name}${quote} ${separator} ${quote}${"aB0/+=".repeat(6)}abcd${quote}`;
        assert.deepEqual(findSecrets(line), ["aws-secret-key"]);
        assert.deepEqual(findSecrets(`${line} # qc-allow-secret`), []);
        assert.ok(!redactOutput(line).includes("aB0/+=".repeat(6) + "abcd"));
      }
    }
  }
});
