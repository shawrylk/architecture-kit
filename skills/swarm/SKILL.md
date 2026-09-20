---
name: swarm
description: The protocol for several agents working one repository at once — exclusive paths, index-first, generated registries, never two edits to one file. Use when dispatching work orders, coordinating parallel units, or deciding whether a change needs the orchestrator.
---

# Swarm

- A work order owns an exclusive set of paths. It writes nowhere else.
- Cross-feature reuse is a kernel `fragment`, requested from the orchestrator — never an edit into
  another feature's folder.
- **Never batch multiple edits to the same file in one parallel block.** Read-modify-write races
  silently lose all but the last edit, and every one reports success.
- Shared files are removed structurally, not scheduled: features self-register through their
  `index`; codegen writes the composition root, the schema barrel and the invalidation graph. Those
  generated files are never hand-edited.
- The first commit of a feature work order is its `index.ts` signature — types, query keys, fan-out
  edges, method names, no bodies — so downstream units are not blocked.
- Changing a published `index` signature is a request to the orchestrator.
- Exit criteria are machine-checkable: typecheck, lint, `qc check`, the feature's tests, contract
  lint, claimed ids resolved. `docs/enforcement.md` lists the commands.

## Dispatch

Run feature units one at a time unless their paths are provably disjoint. Before each dispatch,
confirm the tree is green: a red tree mid-dispatch is usually another unit still running, and the
answer is to wait, not to edit.

A gate must not bend the work. If a unit cannot pass a gate, that is a finding for the orchestrator,
not a reason to edit the gate. Wire new gates in between units, never during one.
