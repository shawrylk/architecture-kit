// A rule reads its shape from its own options, so it stays a standard ESLint rule.
// The preset fills those options from qc.config.json; a rule used bare keeps the
// reference defaults, which is what makes adoption a no-op for a repo that matches.

/** Escape a literal path or module name for use inside a RegExp. */
export function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every path pattern below is forward-slash; `context.filename` is the OS separator, "\\" on Windows. */
export function filenameOf(context) {
  return (context.filename ?? "").replaceAll("\\", "/");
}

/** `platform/api-client.ts` -> matches any file ending in that path. */
export function pathSuffix(value) {
  return new RegExp(`(?:^|/)${escape(value)}$`);
}

/** `backend/src/infrastructure/db/` -> matches any file under that directory. */
export function pathPrefix(value) {
  return new RegExp(`(?:^|/)${escape(value.replace(/\/$/, ""))}/`);
}

// A glob with `*` segments, e.g. frontend features' trigger file, at any extension.
export function pathGlob(value) {
  const body = value.split("/").map((part) => (part === "*" ? "[^/]+" : escape(part))).join("/");
  return new RegExp(`(?:^|/)${body}\\.[cm]?[jt]sx?$`);
}

export function moduleGroup(names) {
  return new RegExp(`^(?:${names.map(escape).join("|")})(?:/|$)`);
}

/** `@aws-sdk` -> matches any package published under that npm scope. */
export function scopeGroup(scopes) {
  return new RegExp(`^(?:${scopes.map(escape).join("|")})/`);
}

export function suffixGroup(names) {
  return new RegExp(`(?:${names.map(escape).join("|")})$`);
}

export const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Options are optional everywhere: one object, every key defaulted by the rule. */
export function schemaOf(properties) {
  return [{ type: "object", properties, additionalProperties: false }];
}

export function optionsOf(context) {
  return context.options[0] ?? {};
}
