#!/usr/bin/env bash
# For each check the kit ships, inject one real violation into a real repository and
# require that exact check to fire. A check that cannot be made to fail is not a check.
set -uo pipefail
P="$1"; QC="$2"
pass=0; fail=0
cd "$P" || exit 1

# qc.config.json is excluded from the clean because a target may keep it untracked, so a case
# that edits it cannot rely on git to put it back. Snapshot it instead.
CFG_BAK=$(mktemp); cp "$P/qc.config.json" "$CFG_BAK" 2>/dev/null || true

restore() {
  git -C "$P" checkout -q -- . 2>/dev/null
  git -C "$P" clean -qfd -e node_modules -e qc.config.json -e docs 2>/dev/null
  [ -s "$CFG_BAK" ] && cp "$CFG_BAK" "$P/qc.config.json"
}

# The block carrying a workflow is named by config, not by this script: anatomies differ.
export HEADLESS
HEADLESS=$(node "$QC" config | python3 -c 'import json,sys;b=json.load(sys.stdin)["saga"]["headlessBlock"];print(" ".join(b if isinstance(b,list) else [b]))')

# A probe that fails to inject proves nothing, so it is reported apart from a check that did not fire.
gate() {
  local name="$1" expect="$2"; shift 2
  if ! ( "$@" ) >/dev/null 2>&1; then
    printf "  NO-PROBE %-24s %s\n" "$expect" "$name"; fail=$((fail+1)); restore; return
  fi
  local out; out=$(node "$QC" check 2>&1)
  if grep -q "$expect" <<< "$out"; then printf "  CAUGHT   %-24s %s\n" "$expect" "$name"; pass=$((pass+1));
  else printf "  MISSED   %-24s %s\n" "$expect" "$name"; fail=$((fail+1)); fi
  restore
}

# A lint case: lint the touched path, require the named rule id.
rule() {
  local name="$1" expect="$2" target="$3"; shift 3
  if ! ( "$@" ) >/dev/null 2>&1; then
    printf "  NO-PROBE %-28s %s\n" "$expect" "$name"; fail=$((fail+1)); restore; return
  fi
  local out; out=$(npx eslint "$target" --max-warnings 0 2>&1)
  if grep -q "$expect" <<< "$out"; then printf "  CAUGHT   %-28s %s\n" "$expect" "$name"; pass=$((pass+1));
  else printf "  MISSED   %-28s %s\n" "$expect" "$name"; fail=$((fail+1)); fi
  restore
}

# A command case: run a qc subcommand, require the named phrase. Not every check is `qc check`.
cmd() {
  local name="$1" expect="$2"; shift 2
  if ! ( "$@" ) >/dev/null 2>&1; then
    printf "  NO-PROBE %-24s %s\n" "$expect" "$name"; fail=$((fail+1)); restore; return
  fi
  local out; out=$(node "$QC" decisions --check 2>&1)
  if grep -q "$expect" <<< "$out"; then printf "  CAUGHT   %-24s %s\n" "$expect" "$name"; pass=$((pass+1));
  else printf "  MISSED   %-24s %s\n" "$expect" "$name"; fail=$((fail+1)); fi
  restore
}

echo "--- gates ---"
gate "disallowed subfolder in a feature" "disallowed-subfolder" \
  bash -c 'mkdir -p backend/src/features/pins/helpers && echo "export const x = 1;" > backend/src/features/pins/helpers/u.ts'
gate "a cited decision that does not exist" "undefined-decision" \
  bash -c 'echo "// ADR-9999 says so" >> backend/src/features/pins/index.ts'
gate "a cited doc that does not exist" "missing-doc" \
  bash -c 'echo "see docs/nonexistent-doc.md" >> docs/architecture.md'
gate "a statement with no tenant predicate" "unscoped-statement" \
  bash -c 'printf "\nexport const LEAK = \`select id from pins\`;\n" >> backend/src/features/pins/shared/queries.ts'
gate "a query naming an undeclared column" "undeclared-sql-identifier" \
  bash -c 'printf "\nexport const BAD = \`select no_such_column from pins where tenant_id = \$1\`;\n" >> backend/src/features/pins/shared/queries.ts'
gate "a public route the edge does not forward" "public-route-unreachable" \
  python3 -c 'import pathlib,re;p=pathlib.Path("backend/src/features/pins/trigger.ts");s=p.read_text();m=re.search(r"\{\s*method:\s*\"\w+\",\s*path:\s*\"[^\"]+\",\s*auth:\s*\"\w+\"",s);p.write_text(s.replace(m.group(0),chr(123)+" method: \"GET\", path: \"/v1/leak\", auth: \"public\"",1))'
gate "a worker posting to an unserved route" "unserved-internal-route" \
  bash -c 'printf "\nconst bad = \`\${base}/v1/internal/no-such-route\`;\n" >> workers/media-process/src/entry.ts'
gate "the block carrying a workflow importing the view layer" "headless-pipeline-no-view" \
  bash -c "for b in \$HEADLESS; do f=\$(ls backend/src/features/*/\"\$b\".ts frontend/src/features/*/\"\$b\".ts 2>/dev/null | head -1); [ -n \"\$f\" ] && break; done; [ -n \"\$f\" ] || exit 1; sed -i \"1i import * as React from 'react';\" \"\$f\""
gate "a saga no test names" "untested-saga" \
  bash -c 'printf "\nexport const orphanPipeline = definePipeline({ name: \"orphan\", steps: [] });\n" >> backend/src/features/pins/slices/create-pin.ts'
gate "a repository gate with no test" "unproven-gate" \
  bash -c 'mkdir -p scripts/gate && echo "export function checkNothing() { return []; }" > scripts/gate/nothing.mjs'
gate "an update against the audit log" "audit-mutated" \
  bash -c 'printf "\nexport const BAD = \`update audit_log set actor = \$1 where tenant_id = \$2\`;\n" >> backend/src/features/pins/shared/queries.ts'
gate "the map naming a check that is gone" "unknown-check" \
  bash -c 'sed -i "s|qc/no-raw-fetch|qc/no-such-rule|" docs/enforcement.md'
gate "a claimed requirement with no test" "unregistered-requirement" \
  bash -c 'sed -i "0,/req: \[/s//req: [\"REQ-ZZZ-999\", /" backend/src/features/pins/trigger.ts'
gate "a constant disagreeing with its registry" "registry-disagreement" \
  bash -c 'sed -i "s/  clientDefault: 600,/  clientDefault: 900,/" backend/src/application/ports/storage.ts'
gate "an agreement left checking nothing" "unfound-constant" \
  bash -c 'sed -i "s/export const PRESIGN_LIFETIME_SECONDS/export const RENAMED_LIFETIMES/" backend/src/application/ports/storage.ts'
gate "a config whose feature roots match nothing" "unfound-root" \
  bash -c 'echo "{\"featureRoots\": [\"nowhere/src/features\"]}" > qc.config.json'

echo "--- decisions ---"
cmd "a citation to a decision that was deleted" "cited and not defined" \
  bash -c "f=\$(ls backend/src/drizzle/*.sql 2>/dev/null | head -1); [ -n \"\$f\" ] || exit 1; printf '\n-- ADR-4242 is not a decision.\n' >> \"\$f\""
cmd "a gap left in the register" "gap(s) below" \
  python3 -c "import pathlib,re;p=pathlib.Path('docs/decisions.md');s=p.read_text();m=re.search(r'^\| (ADR|QC)-0*2 \|',s,re.M);p.write_text(s[:m.start()]+s[m.end()-len(m.group(0)):].replace(m.group(0), m.group(0).replace('-02','-92').replace('-002','-092').replace('-0002','-0092'),1))"

echo "--- rules ---"
T=backend/src/features/pins/shared/queries.ts
rule "a number in a comment" "no-number-in-comment" "$T" bash -c 'printf "\n// retry up to 3 times\n" >> '"$T"
rule "a supersession trail" "no-supersession-trail" "$T" bash -c 'printf "\n// deprecated, use the other one\n" >> '"$T"
rule "offset pagination" "no-offset-pagination" "$T" bash -c 'printf "\nexport const page = { offset: 20 };\n" >> '"$T"
rule "a hand-written status" "no-status-literal" "$T" bash -c 'printf "\nexport function send(reply) { reply.status(404); }\n" >> '"$T"
rule "an idempotency key minted inline" "durable-idempotency-key" "$T" bash -c 'printf "\nexport const go = () => send({ mutationId: crypto.randomUUID(), ledger: durable });\n" >> '"$T"
rule "an async export with no signal" "signal-last-param" "$T" bash -c 'printf "\nexport async function loadThing(id: string) { return id; }\n" >> '"$T"
rule "reaching inside another feature" "no-cross-feature-internals" backend/src/features/pins/index.ts \
  bash -c 'sed -i "1i import { x } from \"../photos/resource.js\";" backend/src/features/pins/index.ts'
rule "storage imported outside resource" "storage-only-in-resource" backend/src/features/pins/trigger.ts \
  bash -c 'sed -i "1i import { sql } from \"drizzle-orm\";" backend/src/features/pins/trigger.ts'
rule "a singleton repository" "scoped-repository" "$T" bash -c 'printf "\nc.register(asClass(PinRepository).singleton());\n" >> '"$T"
rule "a table with no tenant column" "tenant-scoped-table" backend/src/features/pins/schema.ts \
  bash -c 'printf "\nexport const leaky = pgTable(\"leaky\", { id: text(\"id\") });\n" >> backend/src/features/pins/schema.ts'
rule "fetch outside the api client" "no-raw-fetch" frontend/src/features/pins/pipeline.ts \
  bash -c 'printf "\nexport const grab = () => fetch(\"/v1/pins\");\n" >> frontend/src/features/pins/pipeline.ts'
rule "orchestration in a UI trigger" "no-orchestration-in-trigger" frontend/src/features/pins/trigger.tsx \
  bash -c 'printf "\nasync function orchestrate() { await stepOne(); await stepTwo(); await stepThree(); }\n" >> frontend/src/features/pins/trigger.tsx'
rule "a promise continued with a callback" "no-promise-then" "$T" \
  bash -c 'printf "\nexport const late = () => Promise.resolve(1).then((n) => n + 1);\n" >> '"$T"
rule "a comment paragraph" "no-comment-paragraph" "$T" \
  bash -c 'printf "\n// one line of prose\n// a second line of prose\n// a third line of prose\nexport const noted = 1;\n" >> '"$T"

echo ""
echo "caught $pass, missed $fail"
