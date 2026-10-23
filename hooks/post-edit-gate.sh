#!/usr/bin/env bash
# Fast checks only — sub-second. The expensive pass is the Stop hook.
# A doc is input an agent may skip; a hook result is a tool output it must react to.
set -uo pipefail

FILE=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.tool_input?.file_path??"")}catch{}})' 2>/dev/null)
[ -z "$FILE" ] && exit 0
# A Windows hook input uses backslashes, which neither `case` nor `dirname` reads as separators.
FILE=${FILE//\\//}
case "$FILE" in
  *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac

# Judge the checkout that holds the file, not the one the session opened: a work order edits its
# own worktree. The plugin is installed everywhere and does nothing where the kit is not adopted.
ROOT=$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$ROOT/qc.config.json" ] || exit 0

cd "$ROOT" || exit 0
# The repository pins its harness, so its enforcement map and its checker agree.
if [ -f "$ROOT/node_modules/architecture-harness/src/cli/qc.mjs" ]; then
  QC_CLI="$ROOT/node_modules/architecture-harness/src/cli/qc.mjs"
else
  QC_CLI="${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli/qc.mjs"
fi
# An installed harness too old to carry `qc lint` leaves it to the bundled copy.
if [ -f "$(dirname "$QC_CLI")/lint-changed.mjs" ]; then TOOL_CLI="$QC_CLI"; else TOOL_CLI="${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli/qc.mjs"; fi

OUT=""
# Only the lines the change adds: an older problem in the same file is not this edit's to fix.
LINT=$(node "$TOOL_CLI" lint "$FILE" 2>&1) || OUT+="$LINT"$'\n'
# Every source file, not only a path with `features/` in it: featureRoots and featureDir are the
# repository's own, and a per-file check outside a feature still reads its comments.
STRUCT=$(node "$QC_CLI" check "$FILE" 2>&1) || OUT+="$STRUCT"$'\n'

if [ -n "$OUT" ]; then
  echo "$OUT" >&2
  echo "Fix these before continuing." >&2
  exit 2   # non-zero with stderr is fed back to the model
fi
# A warning on a changed line reaches the model as context, and the edit stands.
if printf '%s' "$LINT" | grep -q '  warning  '; then
  node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:process.argv[1]}}))' "$LINT"
fi
exit 0
