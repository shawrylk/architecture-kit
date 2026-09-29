// A resource: the operation ids of the contract and the ledger as they stood at the merge base with
// a ref. Git answers; no answer is a reason to skip, never a failure.

import path from "node:path";
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
 * @param {{base: string, contract: string, legacy: string}} options paths relative to `root`
 * @returns {Promise<{skip: string} | {ledger: string[], ids: string[]}>}
 */
export async function contractHistory(root, { base, contract, legacy }) {
  if (git(root, "rev-parse", "--verify", "--quiet", "HEAD") === null) return { skip: "no git, or no commit yet" };
  if (git(root, "rev-parse", "--verify", "--quiet", `${base}^{commit}`) === null) return { skip: `no ref '${base}'` };
  const mergeBase = git(root, "merge-base", base, "HEAD")?.trim();
  if (!mergeBase) return { skip: `no merge base with '${base}', as in a shallow clone` };
  const at = (file) => git(root, "show", `${mergeBase}:./${file.split(path.sep).join("/")}`);
  const contractText = at(contract);
  let ids = [];
  try {
    ids = contractText === null ? [] : (await contractOperations(contractText)).map((operation) => operation.id);
  } catch {
    return { skip: `the contract at the merge base with '${base}' is unreadable` };
  }
  return { ledger: ledgerOf(at(legacy)), ids };
}
