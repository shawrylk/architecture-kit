#!/usr/bin/env bash
# Enforces swarm.md: a work order owns an exclusive set of paths. The actual logic is a
# node script so it can parse the hook's JSON and emit a well-formed deny — see
# packages/qc-harness/src/cli/work-order-guard.mjs.
set -uo pipefail
node "${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli/work-order-guard.mjs"
