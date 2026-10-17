// A YAML flow mapping such as `{ description: Rows, sorted. }` splits one sentence into a second key with
// no value. Redocly accepts it, so this gate reads the composed contract for the two marks it leaves.

const VALUE_KEYS = new Set(["example", "examples", "default", "const", "enum"]);

const pointer = (at, key) => `${at}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;

/**
 * @param {unknown} document the parsed contract
 * @param {string} contract the contract path, as a problem names it
 */
export function checkContractKeys(document, contract) {
  const problems = [];
  const visit = (node, at) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${at}/${index}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      const here = pointer(at, key);
      if (key.endsWith(".")) {
        problems.push({ path: contract, rule: "contract-key-ends-with-dot", detail: `${here}: a key that ends with "." is the tail of a sentence the YAML split; quote the text it came from` });
      }
      if (value === null && !VALUE_KEYS.has(key)) {
        problems.push({ path: contract, rule: "contract-null-value", detail: `${here} holds no value; give it one, or quote the text it was split from` });
      }
      if (!VALUE_KEYS.has(key) && !key.startsWith("x-")) visit(value, here);
    }
  };
  visit(document, "#");
  return problems;
}
