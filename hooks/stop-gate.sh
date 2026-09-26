#!/usr/bin/env bash
# The expensive pass. Refuses to end a turn while the repo is red.
set -uo pipefail

# Read the hook input first: `stop_hook_active` says this stop already follows a refusal.
ACTIVE=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).stop_hook_active===true?"1":"")}catch{}})' 2>/dev/null)

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$ROOT/qc.config.json" ] || exit 0
cd "$ROOT" || exit 0

# A fixed path in the system temp directory collides when two projects run at once.
LOGS=$(mktemp -d) || exit 0
trap 'rm -rf "$LOGS"' EXIT

# The repository pins its harness, so its enforcement map and its checker agree. A session keeps
# the plugin it started with, and that bundled copy is only the fallback for a repository with none.
if [ -f "$ROOT/node_modules/architecture-harness/src/cli/qc.mjs" ]; then
  QC_CLI="$ROOT/node_modules/architecture-harness/src/cli/qc.mjs"
else
  QC_CLI="${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli/qc.mjs"
fi
FAIL=""
DRIFT=""

if [ -f "$ROOT/node_modules/.bin/tsc" ]; then
  npx tsc -b --pretty false >"$LOGS/tsc" 2>&1 || FAIL+="typecheck failed:\n$(tail -20 "$LOGS/tsc")\n"
fi
if [ -f "$ROOT/node_modules/.bin/eslint" ]; then
  npx eslint . --max-warnings 0 >"$LOGS/lint" 2>&1 || FAIL+="lint failed:\n$(tail -20 "$LOGS/lint")\n"
fi
# The doctor compares the plugin, the lockfile and the git hooks. Its findings are about the setup,
# not the code, so they are kept apart from the code's failures.
# A copy too old to carry `doctor` answers with its usage text and exit 1, which is not drift.
# Probe for the file, so "no doctor here" stays distinguishable from "doctor says no".
DOCTOR=""
for candidate in "$ROOT/node_modules/architecture-harness/src/cli" "${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli"; do
  if [ -f "$candidate/doctor.mjs" ]; then DOCTOR="$candidate/qc.mjs"; break; fi
done
if [ -n "$DOCTOR" ] && ! node "$DOCTOR" doctor >"$LOGS/doctor" 2>&1; then
  DRIFT="$(cat "$LOGS/doctor")"
fi

if ! node "$QC_CLI" check >"$LOGS/struct" 2>&1; then
  # Hook drift is about the setup too, so a check whose every failure is hook drift is drift.
  if grep -q '^FAIL' "$LOGS/struct" && ! grep '^FAIL' "$LOGS/struct" | grep -qv ' hook-drift: '; then
    DRIFT="${DRIFT:+$DRIFT
}$(cat "$LOGS/struct")"
  else
    FAIL+="structure failed:\n$(cat "$LOGS/struct")\n"
  fi
fi

# Anything else this repository wants in the stop gate.
if [ -n "${QC_STOP_EXTRA:-}" ]; then
  eval "$QC_STOP_EXTRA" >"$LOGS/extra" 2>&1 || FAIL+="$QC_STOP_EXTRA failed:\n$(tail -20 "$LOGS/extra")\n"
fi

if [ -n "$FAIL" ]; then
  [ -n "$DRIFT" ] && printf '%s\n' "$DRIFT" >&2
  printf '%b' "$FAIL" >&2
  echo "The repo is red. Do not stop here — fix it. docs/enforcement.md." >&2
  exit 2
fi
if [ -n "$DRIFT" ]; then
  # A second refusal for drift alone would loop the session: an agent cannot restart its own plugin.
  if [ -n "$ACTIVE" ]; then
    MESSAGE="The kit setup still drifts (qc doctor or hook-drift), not the code. Fix it outside this session: $(printf '%s' "$DRIFT" | head -1)"
    node -e 'process.stdout.write(JSON.stringify({systemMessage: process.argv[1]}))' "$MESSAGE"
    exit 0
  fi
  printf '%s\n' "$DRIFT" >&2
  echo "This is drift in the kit setup, not in your code: qc doctor or hook-drift. Fix what it names." >&2
  exit 2
fi
exit 0
