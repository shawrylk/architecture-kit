# Adversarial suite

The unit suite is the kit grading its own homework: each check is proven against fixtures the
same author wrote. This is the other half — inject one real violation per check into a real
repository and require that exact check to fire.

```bash
./evals/adversarial.sh <path-to-a-repo-that-adopted-the-kit> <path-to>/src/cli/qc.mjs
```

The repository must be a git checkout you are willing to mutate: each case edits a file, runs the
check, and restores with `git checkout` and `git clean`. Run it against a **worktree**, never a
tree with work in it:

```bash
git worktree add --detach /tmp/probe HEAD
```

The target needs `qc.config.json`, an `eslint.config.mjs` built from the kit's preset, and
`node_modules` (symlinking the parent repository's is enough).

## What it found

Every defect below survived the unit suite and was caught here.

- `gate-tests` proved a gate called `nothing.mjs` because an unrelated test contained the English
  word "nothing". A file stem is prose as often as it is a filename, so the stem now counts only
  where a test imports the file.

It also caught two mistakes in the harness itself, which is the point of running it against real
code: the probe was linting through the repository's own old config rather than the kit's preset,
so nine rules appeared to pass that were never exercised.
