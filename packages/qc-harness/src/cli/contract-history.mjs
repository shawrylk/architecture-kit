// A resource: the operations of the contract and the ledger as they stood at the merge base with a
// ref. Git answers a missing ref or clone with a skip, never a failure. A base contract that does
// not parse is reported, because the check cannot say what it could not read.

import path from "node:path";
import { owesKey } from "../gates/contract-idempotency.mjs";
import { contractOperations } from "../gates/contract-operations.mjs";
import { git } from "./registry-history.mjs";

/** The ledger's ids as `git show` returned them. A missing or unreadable file is an empty ledger. */
function ledgerOf(text) {
  try {
    const parsed = JSON.parse(text ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} root the repository root, or a folder inside one
 * @param {{base: string, contract: string, legacy: string, fields: string[], exemptDeleteById: boolean}} options
 *   the paths are relative to `root`; `fields` and `exemptDeleteById` decide which operation `owed` its key
 * @returns {Promise<{skip: string} | {unreadable: string} | {ledger: string[], operations: {id: string, method: string, path: string, owed: boolean}[]}>}
 */
export async function contractHistory(root, { base, contract, legacy, fields, exemptDeleteById }) {
  if (git(root, "rev-parse", "--verify", "--quiet", "HEAD") === null) return { skip: "no git, or no commit yet" };
  if (git(root, "rev-parse", "--verify", "--quiet", base + "^{commit}") === null) return { skip: "no ref '" + base + "'" };
  const mergeBase = git(root, "merge-base", base, "HEAD")?.trim();
  if (!mergeBase) return { skip: "no merge base with '" + base + "', as in a shallow clone" };
  const at = (file) => git(root, "show", mergeBase + ":./" + file.split(path.sep).join("/"));
  const contractText = at(contract);
  let operations = [];
  try {
    const found = contractText === null ? [] : await contractOperations(contractText);
    operations = found.map((operation) => ({
      id: operation.id,
      method: operation.method,
      path: operation.path,
      owed: owesKey(operation, { fields, exemptDeleteById }),
    }));
  } catch (error) {
    return { unreadable: "the contract at the merge base with '" + base + "' does not parse: " + error.message };
  }
  return { ledger: ledgerOf(at(legacy)), operations };
}
