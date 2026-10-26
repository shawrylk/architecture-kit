import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findSecrets } from "./secret-patterns.mjs";

const samples = [
  ["aws-access-key", `AKIA${"A".repeat(16)}`],
  ["aws-access-key", `ASIA${"B".repeat(16)}`],
  ["aws-secret-key", "AWS_SECRET_ACCESS_KEY"], // qc-allow-secret
  ...["p", "o", "u", "s", "r"].map((kind) => ["github-token", `gh${kind}_${"a".repeat(36)}`]),
  ["github-pat", `github_pat_${"a".repeat(40)}`],
  ["private-key", "-----BEGIN RSA PRIVATE KEY-----"], // qc-allow-secret
  ["private-key", "-----BEGIN PRIVATE KEY-----"], // qc-allow-secret
  ["anthropic-key", `sk-ant-${"a".repeat(20)}`],
  ...["a", "b", "p", "r", "s"].map((kind) => ["slack-token", `xox${kind}-${"a".repeat(10)}`]),
  ["npm-token", `npm_${"a".repeat(36)}`],
];

for (const [rule, sample] of samples) {
  test(`detects ${rule}: ${sample.slice(0, 8)}`, () => {
    assert.ok(findSecrets(`token=${sample}`).includes(rule));
    assert.deepEqual(findSecrets(`token=${sample} # qc-allow-secret`), []);
  });
}

test("ordinary text and short token prefixes pass", () => {
  assert.deepEqual(findSecrets("const token = 'ghp_short'; // AWS_ACCESS_KEY_ID"), []);
});
