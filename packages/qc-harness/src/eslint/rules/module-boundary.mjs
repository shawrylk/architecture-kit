// Shared by every rule that restricts a module to specific files or paths — one mechanism,
// each rule its own semantic boundary (storage, an external service's SDK, ...).

import { pathPrefix } from "../options.mjs";

/** @param filename forward-slash — pass `filenameOf(context)`, never `context.filename` directly.
 *  @returns true when this file is allowed to import the restricted module regardless. */
export function isExemptFile(filename, { allowedBasenames = [], allowedPathPrefixes = [] } = {}) {
  const base = filename.split("/").pop() ?? "";
  if (allowedBasenames.includes(base)) return true;
  return allowedPathPrefixes.some((prefix) => pathPrefix(prefix).test(filename));
}
