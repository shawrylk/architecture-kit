import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { applyBlock } from "./setup-block.mjs";
import { checkTools, personSteps } from "./setup-checks.mjs";
import { budgetsOf, compactClaude, compactCodex } from "./setup-compaction.mjs";
import { dropPersonalSkills } from "./setup-skills.mjs";
import { assertSafePath, backupFile, configPaths, kitUserConfigDir } from "./user-config.mjs";

/** Resource: read a safe file or use its default when it is absent. */
function read(file, fallback) {
  assertSafePath(file);
  try {
    assertSafePath(realpathSync(file));
    if (!statSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`);
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

/** Resource: list personal skill folders within the resolved skills directory. */
function skillNames(claudeDir) {
  const root = path.join(claudeDir, "skills");
  if (!existsSync(root)) return [];
  const resolvedRoot = realpathSync(root);
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const folder = path.join(root, entry.name);
    const relative = path.relative(resolvedRoot, realpathSync(folder));
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error(`Skill folder leaves the skills directory: ${folder}`);
    }
    assertSafePath(folder);
    const skill = path.join(folder, "SKILL.md");
    if (existsSync(skill)) read(skill);
    return entry.name;
  });
}

/** Pipeline: plan user setup, then apply changes after all checks pass. */
export async function runSetup(args, options = {}) {
  const log = options.log ?? console.log;
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      "dry-run": { type: "boolean" }, config: { type: "string" }, model: { type: "string", multiple: true },
    } });
    if (positionals.length) throw new Error("Usage: qc setup [--dry-run] [--config <file>] [--model <id>]...");
    const home = options.home ?? os.homedir();
    const paths = configPaths(home, options.env ?? process.env);
    const claudeDir = path.dirname(paths.claude);
    const codexDir = path.dirname(paths.codex);
    const cwd = options.cwd ?? process.cwd();
    const config = path.resolve(cwd, values.config ?? "qc.config.json");
    const budgets = budgetsOf(read(config, null));
    const claude = compactClaude(read(paths.claude, "{}"), { models: values.model ?? [], window: budgets.orchestrator });
    const codex = compactCodex(read(paths.codex, ""), budgets.codex);
    const coreFile = path.join(claudeDir, "CLAUDE.md");
    const template = path.join(options.kitDir ?? kitUserConfigDir(), "claude", "CLAUDE.core.md");
    const core = applyBlock(read(coreFile, ""), read(template));
    const plans = [
      { file: paths.claude, ...claude },
      { file: paths.codex, ...codex },
      { file: coreFile, text: core.text, changed: core.changed ? ["core"] : [] },
    ].filter((plan) => plan.changed.length);
    const skillsOptions = { claudeDir, settingsText: claude.text, names: skillNames(claudeDir) };
    const skills = dropPersonalSkills({ ...skillsOptions, dryRun: true });
    const tools = checkTools(options.run);
    const steps = personSteps({ tools, home, codexDir, run: options.run, exists: options.exists });
    if (budgets.orchestrator !== null && !values.model?.length) {
      steps.push("Run `qc setup --model <id>` to set the Claude compaction window");
    }
    for (const kept of skills.kept) steps.push(`Check ${kept.path}: ${kept.reason}`);

    if (!values["dry-run"]) {
      const now = options.now ?? new Date();
      for (const plan of plans) {
        assertSafePath(plan.file);
        if (existsSync(plan.file)) backupFile(plan.file, now);
      }
      for (const plan of plans) {
        mkdirSync(path.dirname(plan.file), { recursive: true });
        writeFileSync(plan.file, plan.text, { mode: 0o600 });
      }
      dropPersonalSkills(skillsOptions);
    }
    const prefix = values["dry-run"] ? "Would change" : "Change";
    for (const plan of plans) {
      for (const key of plan.changed) log(`${prefix} ${plan.file}: ${key}`);
    }
    for (const folder of skills.removed) log(`${prefix} ${folder}: remove personal skill`);
    if (!plans.length && !skills.removed.length) log("Setup matches.");
    if (steps.length) {
      log("Steps for a person:");
      for (const step of steps) log(`  - ${step}`);
    }
    return 0;
  } catch (error) {
    log(`qc setup: ${error.message}`);
    return 2;
  }
}
