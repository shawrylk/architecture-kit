import { findSecrets } from "./secret-patterns.mjs";

const AI_LABEL = "Written by an AI agent with architecture-kit.";

/** Fragment: redact credential tokens and key headers before a public post. */
export function redactOutput(text) {
  return text.replace(/-----[^\r\n]*?-----|[A-Za-z0-9_-]+/g, (token) =>
    findSecrets(token.replaceAll("qc-allow-secret", "")).length ? "[REDACTED]" : token);
}

/** Pipeline: redact a body and append its configured attribution once. */
export function postBody(text, config = {}) {
  const redacted = redactOutput(text);
  if (config.post?.aiLabel === false) return redacted;
  const body = redacted.replaceAll(AI_LABEL, "").trimEnd();
  return body ? `${body}\n\n${AI_LABEL}` : AI_LABEL;
}
