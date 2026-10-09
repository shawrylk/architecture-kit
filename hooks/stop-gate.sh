#!/usr/bin/env bash
# The expensive pass. Blocks a red turn. A repeat block with the same failure ends the turn with a note.
set -uo pipefail

# Read the hook input first: `stop_hook_active` says this stop already follows a refusal, and
# `session_id` keys the memory of the last refusal. The session id is cut to letters, digits, dash and
# underscore, so it is safe in a file name. The output is `<1 or empty>|<session>`.
INPUT=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=JSON.parse(s);process.stdout.write((i.stop_hook_active===true?"1":"")+"|"+String(i.session_id??"").replace(/[^A-Za-z0-9_-]/g,"").slice(0,128))}catch{}})' 2>/dev/null)
ACTIVE="${INPUT%%|*}"
SESSION="${INPUT#*|}"
[ "$SESSION" = "$INPUT" ] && SESSION=""

# The memory of the last refusal: one file per session under the system temp folder, holding the
# sha256 of the full failure log, with the timing lines of a test runner replaced by a fixed token, so a
# run that only takes a different time hashes the same. A time inside an assertion message stays. `same` exits 10 when this is a repeat stop and the
# text is the one last refused, and stores the hash otherwise. Every other outcome, an unreadable or unwritable file included, exits 0,
# so the gate blocks as it did before it had a memory.
MEMORY_JS='
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const [mode, session, active] = process.argv.slice(1);
try {
  if (!session) process.exit(0);
  const dir = path.join(os.tmpdir(), "qc-stop-gate");
  const file = path.join(dir, session + ".last");
  if (mode === "clear") { fs.rmSync(file, { force: true }); process.exit(0); }
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    try {
      // Only the timing lines of a runner change from run to run. The 200ms in an assertion message is not one.
      const steady = raw
        .split("\n")
        .map((line) => {
          if (/^\s*(?:Start at|Duration|\u2139 duration_ms|# duration_ms)/.test(line)) return "<timing>";
          if (/^\s*[\u2713\u00d7\u2717\u276f\u2193\u2714\u2716]/.test(line)) return line.replace(/ \(?\d+(?:\.\d+)?(?:ms|s)\)?(\s*)$/, " <duration>$1");
          return line;
        })
        .join("\n");
      const text = require("node:crypto").createHash("sha256").update(steady).digest("hex");
      let last = null;
      try { last = fs.readFileSync(file, "utf8"); } catch {}
      if (active === "1" && last === text) process.exit(10);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, text);
    } catch {}
    process.exit(0);
  });
} catch { process.exit(0); }
'

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
# A real newline, so the failure text prints as it is, backslashes and all.
NL=$'\n'
FAIL=""
# The same failures with each log whole, not its last 20 lines: what the repeat memory hashes.
FULL=""
DRIFT=""

if [ -f "$ROOT/node_modules/.bin/tsc" ]; then
  TSC_FAILED=""
  npx tsc -b --pretty false >"$LOGS/tsc" 2>&1 || TSC_FAILED=1
  # A concurrent `pnpm install` makes a module vanish for a moment, which tsc reports as TS2307.
  # When that is the only error, run it once more and judge the second run.
  if [ -n "$TSC_FAILED" ] && grep -q 'error TS' "$LOGS/tsc" && ! grep 'error TS' "$LOGS/tsc" | grep -qv 'error TS2307'; then
    TSC_FAILED=""
    npx tsc -b --pretty false >"$LOGS/tsc" 2>&1 || TSC_FAILED=1
  fi
  if [ -n "$TSC_FAILED" ]; then
    FAIL+="typecheck failed:${NL}$(tail -20 "$LOGS/tsc")${NL}"
    FULL+="typecheck failed:${NL}$(cat "$LOGS/tsc")${NL}"
  fi
fi
if [ -f "$ROOT/node_modules/.bin/eslint" ]; then
  npx eslint . --max-warnings 0 >"$LOGS/lint" 2>&1 || {
    FAIL+="lint failed:${NL}$(tail -20 "$LOGS/lint")${NL}"
    FULL+="lint failed:${NL}$(cat "$LOGS/lint")${NL}"
  }
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
    FAIL+="structure failed:${NL}$(cat "$LOGS/struct")${NL}"
    FULL+="structure failed:${NL}$(cat "$LOGS/struct")${NL}"
  fi
fi

# Anything else this repository wants in the stop gate.
if [ -n "${QC_STOP_EXTRA:-}" ]; then
  eval "$QC_STOP_EXTRA" >"$LOGS/extra" 2>&1 || {
    FAIL+="$QC_STOP_EXTRA failed:${NL}$(tail -20 "$LOGS/extra")${NL}"
    FULL+="$QC_STOP_EXTRA failed:${NL}$(cat "$LOGS/extra")${NL}"
  }
fi

if [ -n "$FAIL" ]; then
  # A block that brings no change ends the turn with a note. The gate adds no cap: a changed failure blocks again.
  printf '%s' "$FULL" | node -e "$MEMORY_JS" same "$SESSION" "$ACTIVE" 2>/dev/null
  if [ $? -eq 10 ]; then
    # Name the failure, not the heading: the first FAIL line, else the first line after the heading.
    FIRST=$(printf '%s' "$FAIL" | grep -m1 '^FAIL')
    [ -n "$FIRST" ] || FIRST=$(printf '%s' "$FAIL" | sed 1d | grep -m1 .)
    [ -n "$FIRST" ] || FIRST=$(printf '%s' "$FAIL" | head -1)
    MESSAGE="The stop gate still fails with the same text as at the last block. Fix it: $FIRST"
    node -e 'process.stdout.write(JSON.stringify({systemMessage: process.argv[1]}))' "$MESSAGE"
    exit 0
  fi
  [ -n "$DRIFT" ] && printf '%s\n' "$DRIFT" >&2
  printf '%s' "$FAIL" >&2
  echo "The repo is red. Do not stop here — fix it. docs/enforcement.md." >&2
  exit 2
fi
# A green gate forgets the last block of this session.
node -e "$MEMORY_JS" clear "$SESSION" </dev/null 2>/dev/null
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
