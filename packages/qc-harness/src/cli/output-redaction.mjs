import { secretPatterns } from "./secret-patterns.mjs";

const AI_LABEL = "Written by an AI agent with architecture-kit.";

/** Index: shares credential patterns and extends private-key headers to whole PEM blocks. */
const patterns = [
  /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
  ...secretPatterns.map(([, pattern]) => new RegExp(pattern.source, `${pattern.flags}g`)),
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
