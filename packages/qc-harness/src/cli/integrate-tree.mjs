import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { globMatcher } from "../glob.mjs";
import { posixDir, renumber } from "./migrations.mjs";

/** Replay each unreviewed merge from its parents, using the integration transformations only. */
export function checkMergeTrees(root, commits, config, git) {
  if (!commits.length) return null;
  const scratch = mkdtempSync(path.join(tmpdir(), "qc-merge-tree-"));
  const read = (cwd, ...args) => {
    const out = git(cwd, ...args);
    if (out === null) throw new Error("cannot reconstruct the expected merge tree within the lane budget");
    return out;
  };
  const options = ["-c", "rerere.enabled=false", "-c", "user.name=qc", "-c", "user.email=qc@localhost"];
  const replay = (...args) => read(scratch, ...options, ...args);
  try {
    const objects = path.resolve(root, read(root, "rev-parse", "--git-path", "objects"));
    const objectFormat = read(root, "rev-parse", "--show-object-format");
    read(scratch, "init", "-q", "--template=", `--object-format=${objectFormat}`);
    mkdirSync(path.join(scratch, ".git", "objects", "info"), { recursive: true });
    writeFileSync(path.join(scratch, ".git", "objects", "info", "alternates"), `${objects}\n`);
    const generated = globMatcher(config.generated?.globs ?? []);
    for (const commit of commits) {
      const parents = read(root, "show", "-s", "--format=%P", commit).split(" ");
      if (parents.length !== 2) return `merge ${commit} is not a two-parent merge`;
      replay("reset", "--hard", parents[0]);
      const merged = git(scratch, ...options, "merge", "--no-ff", "--no-commit", parents[1]);
      if (merged === null) {
        const conflicts = read(scratch, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
        if (!conflicts.length || conflicts.some((file) => !generated(file))) return `merge ${commit} cannot be reconstructed without hand-resolved changes`;
        replay("checkout", "--ours", "--", ...conflicts);
        replay("add", "--", ...conflicts);
      }
      const dir = posixDir(config.paths?.migrations);
      if (dir) renumber(scratch, dir, { onto: parents[0], branch: parents[1] });
      const expected = replay("write-tree");
      if (expected !== read(root, "rev-parse", `${commit}^{tree}`)) return `merge ${commit} was hand-resolved after review: differs from the expected merge tree`;
    }
    return null;
  } catch (error) {
    return error.message;
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
