// A value may be written twice only where a tool demands a literal. Where that
// happens, the gate asserts agreement rather than forbidding the number. QC-007.

const ENTRY = /^\s*(\w+):\s*(\d+),?\s*$/;

/** Numbers declared in a source constant, by key. */
export function declaredValues(source, constantName) {
  const start = source.indexOf(constantName);
  if (start === -1) return {};
  const open = source.indexOf("{", start);
  const close = source.indexOf("};", open);
  const values = {};
  for (const line of source.slice(open + 1, close).split("\n")) {
    const match = ENTRY.exec(line);
    if (match) values[match[1]] = Number(match[2]);
  }
  return values;
}

/**
 * @param {Record<string, number>} declared  key → value in the source
 * @param {Record<string, {value: number}>} registry  registry entries
 * @param {(key: string) => string} toRegistryKey
 */
export function checkAgreement(declared, registry, toRegistryKey, label) {
  const problems = [];
  for (const [key, value] of Object.entries(declared)) {
    const registryKey = toRegistryKey(key);
    const entry = registry[registryKey];
    if (!entry) {
      problems.push({ path: label, rule: "unregistered-value", detail: `${key} (${registryKey})` });
    } else if (entry.value !== value) {
      problems.push({ path: label, rule: "registry-disagreement", detail: `${key}: source has one value, the registry another` });
    }
  }
  return problems;
}
