// A mutating operation names the key that makes a retry a resume: docs/guards.md. The contract
// carries it, so a client cannot call a write that has no way to say "this is the same attempt".
// Operations that predate the gate sit in a ledger. An entry whose operation no longer owes the key
// fails, so a stale entry cannot linger. Nothing here stops a new entry: that is the merge-base check.

const MUTATING = new Set(["post", "put", "patch", "delete"]);
const PARAMETER_SEGMENT = /^(?:\{[^}]+\}|:[^/]+)$/;

/** A DELETE whose last path segment is a parameter names one row, and repeating it changes nothing. */
export function isDeleteById({ method, path }) {
  return method === "delete" && PARAMETER_SEGMENT.test(path.split("/").filter(Boolean).at(-1) ?? "");
}

const declares = (operation, fields) => fields.some((field) => operation.params.includes(field) || operation.bodyProps.includes(field));

/** Why a ledger entry has no work left to do, or null when its operation still owes the field. */
function staleReason(operation, fields, exemptDeleteById) {
  if (!operation) return "is no longer in the contract";
  if (declares(operation, fields)) return "now declares its idempotency field";
  if (!MUTATING.has(operation.method) || (exemptDeleteById && isDeleteById(operation))) return "needs no idempotency field";
  return null;
}

/**
 * @param {{method: string, path: string, id: string, params: string[], bodyProps: string[]}[]} operations
 * @param {string[]} legacy ids of the operations that predate the gate
 * @param {{fields: string[], exemptDeleteById: boolean, contract: string, ledger: string}} options
 *   `contract` and `ledger` are the paths a problem reports
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkContractIdempotency(operations, legacy, { fields, exemptDeleteById, contract, ledger }) {
  const owed = new Set(legacy);
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const problems = [];
  for (const operation of operations) {
    if (!MUTATING.has(operation.method)) continue;
    if (exemptDeleteById && isDeleteById(operation)) continue;
    if (declares(operation, fields) || owed.has(operation.id)) continue;
    problems.push({
      path: contract,
      rule: "missing-idempotency-field",
      detail: `${operation.method.toUpperCase()} ${operation.path} declares none of ${fields.join(", ")} as a body property or a parameter`,
    });
  }
  for (const id of owed) {
    const reason = staleReason(byId.get(id), fields, exemptDeleteById);
    if (reason) problems.push({ path: ledger, rule: "legacy-now-declares", detail: `'${id}' ${reason}; remove it from the ledger` });
  }
  return problems;
}
