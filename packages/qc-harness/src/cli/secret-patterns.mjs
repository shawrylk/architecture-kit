/** Fragment: finds the secret shapes shared with pr-autopilot's commit guard. */
const patterns = [
  ["aws-access-key", /A[KS]IA[0-9A-Z]{16}/],
  ["aws-secret-key", new RegExp("aws_secret" + "_access_key", "i")],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["github-pat", /github_pat_[A-Za-z0-9_]{40,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["slack-token", /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ["npm-token", /npm_[A-Za-z0-9]{36}/],
];

export function findSecrets(line) {
  if (line.includes("qc-allow-secret")) return [];
  return patterns.filter(([, pattern]) => pattern.test(line)).map(([rule]) => rule);
}
