const AI_LABEL = "Written by an AI agent with architecture-kit.";

/** Index: replacement patterns mirror secret-patterns.mjs, whose detector exposes rule names rather than match ranges. */
const patterns = [
  /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
  /A[KS]IA[0-9A-Z]{16}/g,
  /\baws[_-]secret[_-]access[_-]key\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{40,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /npm_[A-Za-z0-9]{36}/g,
];

/** Fragment: redact whole credential matches and complete private-key blocks before a public post. */
export function redactOutput(text) {
  for (const pattern of patterns) text = text.replace(pattern, "[REDACTED]");
  return text;
}

/** Pipeline: redact a body and append its configured attribution once. */
export function postBody(text, config = {}) {
  const redacted = redactOutput(text);
  if (config.post?.aiLabel === false) return redacted;
  let body = redacted.trimEnd();
  while (body === AI_LABEL || body.endsWith(`\n${AI_LABEL}`)) {
    body = body.slice(0, -AI_LABEL.length).trimEnd();
  }
  return body ? `${body}\n\n${AI_LABEL}` : AI_LABEL;
}
