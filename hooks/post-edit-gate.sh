#!/usr/bin/env bash
# Fast checks only — sub-second. The expensive pass is the Stop hook.
# A doc is input an agent may skip; a hook result is a tool output it must react to.
set -uo pipefail

# This plugin is installed for every project. It does nothing in one that has not
# adopted the architecture.
ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$ROOT/qc.config.json" ] || exit 0

FILE=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.tool_input?.file_path??"")}catch{}})' 2>/dev/null)
[ -z "$FILE" ] && exit 0
case "$FILE" in
  *.ts|*.tsx|*.mjs) ;;
  *) exit 0 ;;
esac

cd "$ROOT" || exit 0
QC="node ${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli/qc.mjs"

OUT=""
if [ -f "$ROOT/node_modules/.bin/eslint" ]; then
  LINT=$(npx eslint "$FILE" --max-warnings 0 2>&1) || OUT+="$LINT"$'\n'
fi
case "$FILE" in
  */features/*) STRUCT=$($QC check "$FILE" 2>&1) || OUT+="$STRUCT"$'\n' ;;
esac

if [ -n "$OUT" ]; then
  echo "$OUT" >&2
  echo "Fix these before continuing. See docs/enforcement.md." >&2
  exit 2   # non-zero with stderr is fed back to the model
fi
exit 0
