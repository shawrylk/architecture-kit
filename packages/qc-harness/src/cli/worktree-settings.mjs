// A fragment that reads the worktree rule of QC-015 for the hooks: the folder that holds each worktree,
// and the ledger that records a merge. It is on wherever `qc.config.json` is, until `worktree.enforce` is false.

import { existsSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, load } from "../config.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { commonDirOf, ledgerFileOf } from "./ledger.mjs";

/**
 * @returns `{ root, main, folder, ledger, config }` for the checkout that holds `cwd`, where `main` is the main
 *   checkout and `folder` is its worktree folder; null when the rule is off or the config cannot be read.
 */
export function worktreeRuleAt(cwd) {
  const root = checkoutRootOf(cwd);
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) return null;
  let config;
  try {
    config = load(root);
  } catch {
    return null;
  }
  const common = commonDirOf(root);
  if (config.worktree?.enforce === false || !common) return null;
  const main = path.dirname(common);
  return { root, main, folder: path.join(main, config.worktree.dir), ledger: ledgerFileOf(root), config };
}
