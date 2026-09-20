#!/usr/bin/env bash
# The expensive pass. Refuses to end a turn while the repo is red.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$ROOT/qc.config.json" ] || exit 0
cd "$ROOT" || exit 0

# A fixed path in the system temp directory collides when two projects run at once.
LOGS=$(mktemp -d) || exit 0
trap 'rm -rf "$LOGS"' EXIT

QC="node ${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli/qc.mjs"
FAIL=""

if [ -f "$ROOT/node_modules/.bin/tsc" ]; then
  npx tsc -b --pretty false >"$LOGS/tsc" 2>&1 || FAIL+="typecheck failed:\n$(tail -20 "$LOGS/tsc")\n"
fi
if [ -f "$ROOT/node_modules/.bin/eslint" ]; then
  npx eslint . --max-warnings 0 >"$LOGS/lint" 2>&1 || FAIL+="lint failed:\n$(tail -20 "$LOGS/lint")\n"
fi
# Before judging the repository, check the judge: a stale plugin checkout reports the repository's
# own files as broken, and the failures read exactly like real ones. Drift is reported alone,
# because every structural result underneath it would be untrustworthy anyway.
#
# Run from the installed copy, never the plugin's: a checkout old enough to drift is also old
# enough to have no `doctor`, and it would answer this question with its usage text.
# A copy too old to carry `doctor` answers with its usage text and exit 1, which is not drift.
# Probe for the file, so "no doctor here" stays distinguishable from "doctor says no".
DOCTOR=""
for candidate in "$ROOT/node_modules/architecture-harness/src/cli" "${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli"; do
  if [ -f "$candidate/doctor.mjs" ]; then DOCTOR="$candidate/qc.mjs"; break; fi
done
if [ -n "$DOCTOR" ] && ! node "$DOCTOR" doctor >"$LOGS/doctor" 2>&1; then
  cat "$LOGS/doctor" >&2
  echo "The gates themselves are out of date, so this verdict is not about your code. Fix the checkout." >&2
  exit 2
fi

$QC check >"$LOGS/struct" 2>&1 || FAIL+="structure failed:\n$(cat "$LOGS/struct")\n"

# Anything else this repository wants in the stop gate.
if [ -n "${QC_STOP_EXTRA:-}" ]; then
  eval "$QC_STOP_EXTRA" >"$LOGS/extra" 2>&1 || FAIL+="$QC_STOP_EXTRA failed:\n$(tail -20 "$LOGS/extra")\n"
fi

if [ -n "$FAIL" ]; then
  printf '%b' "$FAIL" >&2
  echo "The repo is red. Do not stop here — fix it. docs/enforcement.md." >&2
  exit 2
fi
exit 0
