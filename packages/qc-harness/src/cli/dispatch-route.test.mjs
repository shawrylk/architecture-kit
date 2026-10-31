import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { codexModelOf, isCodexType, routeRefusal, runtimeTagOf, tagRefusal } from "./dispatch-route.mjs";

function configHome(t, content) {
  const home = mkdtempSync(path.join(os.tmpdir(), "qc-route-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (content !== undefined) writeFileSync(path.join(home, "config.toml"), content);
  return { CODEX_HOME: home };
}

test("codexModelOf reads a top-level model in double or single quotes", (t) => {
  for (const quote of ['"', "'"]) {
    const env = configHome(t, `# model = "ignored"\nmodel = ${quote}gpt-6.1-sol${quote} # runtime\n[profiles.work]\nmodel = "other"\n`);
    assert.equal(codexModelOf(env), "gpt-6.1-sol");
  }
});

test("codexModelOf returns null for a missing file or key and stops at the first table", (t) => {
  for (const content of [undefined, 'model_provider = "openai"\n', '[profiles.work]\nmodel = "other"\n', '  [profiles.work]\nmodel = "other"\n']) {
    assert.equal(codexModelOf(configHome(t, content)), null);
  }
});

test("only codex and architecture:codex use the Codex runtime", () => {
  for (const type of ["codex", "architecture:codex"]) assert.equal(isCodexType(type), true);
  for (const type of ["general-purpose", "architecture:sdd-implementer", "other:codex"]) assert.equal(isCodexType(type), false);
});

test("runtimeTagOf uses the configured Codex model instead of the Agent model", () => {
  for (const subagent_type of ["codex", "architecture:codex"]) {
    const input = { subagent_type, model: "haiku" };
    assert.equal(runtimeTagOf(input, { codexModel: "gpt-6.1-sol" }), "Codex gpt-6.1-sol \u00b7 ");
    assert.equal(runtimeTagOf(input, { codexModel: null }), "Codex default \u00b7 ");
  }
});

test("runtimeTagOf uses the Claude family, model string, or default", () => {
  for (const [model, label] of [["sonnet", "sonnet"], ["claude-opus-4-5", "opus"], ["custom", "custom"], [undefined, "default"]]) {
    assert.equal(runtimeTagOf({ subagent_type: "architecture:sdd-implementer", model }, { codexModel: null }), `Claude ${label} \u00b7 `);
  }
});

test("tagRefusal accepts the exact prefix with optional leading spaces", () => {
  const input = { subagent_type: "architecture:codex", model: "haiku" };
  for (const leading of ["", "   "]) {
    assert.equal(tagRefusal({ ...input, description: `${leading}Codex gpt-6.1-sol \u00b7 work` }, { codexModel: "gpt-6.1-sol" }), null);
  }
});

test("tagRefusal quotes the exact tag for a missing description, wrong runtime, or wrong model", () => {
  const tag = "Codex gpt-6.1-sol \u00b7 ";
  for (const description of [undefined, "work", "Claude gpt-6.1-sol \u00b7 work", "Codex default \u00b7 work"]) {
    assert.equal(
      tagRefusal({ subagent_type: "architecture:codex", description }, { codexModel: "gpt-6.1-sol" }),
      `Dispatch guard: the description of a architecture:codex dispatch must start with "${tag}" so the agent panel shows the runtime and the model. Write "${tag}<what the agent does>".`,
    );
  }
});

const settings = { implementerTypes: ["codex", "architecture:codex", "architecture:sdd-implementer"] };
const limit = { until: new Date("2026-10-26T15:00:00Z"), source: "codex" };

test("routeRefusal refuses Codex while limited and names the Sonnet implementer with the same brief", () => {
  for (const subagent_type of ["codex", "architecture:codex"]) {
    const refusal = routeRefusal({ subagent_type, prompt: "Read the brief.\nBrief: brief.md\nReport: report.md" }, settings, limit);
    for (const text of ["2026-10-26T15:00:00.000Z", "qc codex status", "architecture:sdd-implementer", "sonnet", "Brief: brief.md"]) {
      assert.ok(refusal.includes(text), text);
    }
  }
});

test("routeRefusal allows an implementer while Codex is limited and Codex while free", () => {
  assert.equal(routeRefusal({ subagent_type: "architecture:sdd-implementer", prompt: "Brief: brief.md" }, settings, limit), null);
  for (const subagent_type of ["codex", "architecture:codex"]) {
    assert.equal(routeRefusal({ subagent_type, prompt: "Brief: brief.md" }, settings, null), null);
  }
});

test("routeRefusal requires a Claude Runtime line with a reason for an implementer while Codex is free", () => {
  for (const runtime of ["", "Runtime: claude", "Runtime: codex x", "Runtime: claude   ", "Runtime: claude\nother text"]) {
    const refusal = routeRefusal({ subagent_type: "architecture:sdd-implementer", prompt: `Brief: brief.md\n${runtime}` }, settings, null);
    assert.ok(refusal.includes("Runtime: claude <reason>"), runtime);
  }
  assert.equal(routeRefusal({ subagent_type: "architecture:sdd-implementer", prompt: "Brief: brief.md\nRuntime: claude codex is down" }, settings, null), null);
});

test("routeRefusal uses the configured sdd-implementer fallback and leaves other roles alone", () => {
  const custom = { implementerTypes: ["codex", "custom:sdd-implementer"] };
  assert.ok(routeRefusal({ subagent_type: "codex", prompt: "Brief: brief.md" }, custom, limit).includes("custom:sdd-implementer"));
  assert.equal(routeRefusal({ subagent_type: "general-purpose" }, settings, null), null);
});

test("routeRefusal accepts case variants and zero or more horizontal spaces after Runtime:", () => {
  for (const runtime of ["Runtime:claude reason", "Runtime: Claude reason", "rUnTiMe:\tClAuDe\treason", "  RUNTIME:  CLAUDE reason  "]) {
    assert.equal(routeRefusal({ subagent_type: "architecture:sdd-implementer", prompt: `Brief: brief.md\n${runtime}` }, settings, null), null, runtime);
  }
});
