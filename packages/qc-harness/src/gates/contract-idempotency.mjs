// A mutating operation names the key that makes a retry a resume: docs/guards.md. The contract
// carries it, so a client cannot call a write that has no way to say "this is the same attempt".
// Operations that predate the gate sit in a ledger. An entry whose operation no longer owes the key
// fails, so a stale entry cannot linger. Every ledgered id is also compared with the merge base: the
// operation must keep its id, method and path, and a new entry must have lacked its key there, so the
// ledger cannot absorb a new write.

const MUTATING = new Set(["post", "put", "patch", "delete"]);
const PARAMETER_SEGMENT = /^(?:\{[^}]+\}|:[^/]+)$/;

/** A DELETE whose last path segment is a parameter names one row, and repeating it changes nothing. */
export function isDeleteById({ method, path }) {
  return method === "delete" && PARAMETER_SEGMENT.test(path.split("/").filter(Boolean).at(-1) ?? "");
}

const declares = (operation, fields) => fields.some((field) => operation.params.includes(field) || operation.bodyProps.includes(field));

/** A write that names none of `fields`, and is not a DELETE by id the config exempts. */
export function owesKey(operation, { fields, exemptDeleteById }) {
  return MUTATING.has(operation.method) && !(exemptDeleteById && isDeleteById(operation)) && !declares(operation, fields);
}

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
  const counts = new Map();
  for (const { id } of operations) counts.set(id, (counts.get(id) ?? 0) + 1);
  const problems = [...counts]
    .filter(([, count]) => count > 1)
    .map(([id]) => ({
      path: contract,
      rule: "duplicate-operation-id",
      detail: "'" + id + "' names more than one operation, so the ledger cannot say which one it excuses",
    }));
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

/**
 * Every ledgered id is compared with the merge base, listed there or not, so a listed id cannot be
 * reused for a new write. Each current operation that carries the id must match a base operation with
 * the same id, method and path, and an id new to the ledger must also have been owed its key there. An
 * id the contract no longer holds is `legacy-now-declares`'s to report.
 * @param {string[]} legacy the ledger now
 * @param {{ledger: string[], operations: {id: string, method: string, path: string, owed: boolean}[]}} before
 *   the ledger and the operations at the merge base, `owed` marking one that lacked its key
 * @param {{id: string, method: string, path: string}[]} operations the contract now
 * @param {{ledger: string}} options the path a problem reports
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkLedgerGrowth(legacy, before, operations, { ledger }) {
  const listed = new Set(before.ledger);
  const heldThen = (now) =>
    before.operations.filter((then) => then.id === now.id && then.method === now.method && then.path === now.path);
  const whyNot = (now) => {
    const then = heldThen(now);
    if (then.length === 0) return "the merge base held no operation with its id, method and path";
    if (!listed.has(now.id) && !then.some((held) => held.owed)) return "that operation had its key at the merge base";
    return null;
  };
  const problems = [];
  for (const id of new Set(legacy)) {
    for (const now of operations.filter((operation) => operation.id === id)) {
      const reason = whyNot(now);
      if (reason === null) continue;
      problems.push({
        path: ledger,
        rule: "legacy-grew",
        detail: "'" + id + "' is ledgered for " + now.method.toUpperCase() + " " + now.path + ", but " + reason + "; declare its idempotency field instead",
      });
      break;
    }
  }
  return problems;
}
