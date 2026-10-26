/** Fragment: finds the secret shapes shared with pr-autopilot's commit guard. */
export const secretPatterns = [
  ["aws-access-key", /A[KS]IA[0-9A-Z]{16}/],
  ["aws-secret-key", /(?<![A-Za-z0-9])aws[_-]secret[_-]access[_-]key\b["']?(?:\s*(?:=>|[:=])\s*|\s+)["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["github-pat", /github_pat_[A-Za-z0-9_]{40,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["slack-token", /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ["npm-token", /npm_[A-Za-z0-9]{36}/],
];

export function findSecrets(line) {
  if (line.includes("qc-allow-secret")) return [];
  return secretPatterns.filter(([, pattern]) => pattern.test(line)).map(([rule]) => rule);
}
