// The named block stays callable without a view. `block` takes a list: anatomies name it differently.

const DEFAULT_BLOCK = "pipeline";
const DEFAULT_VIEW_MODULES = ["react", "react-dom"];
const HOOK_IMPORT = /\bimport\s+{[^}]*\b(?:use[A-Z]\w+)[^}]*}\s+from/;

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// An empty or non-string list would silently match nothing, disabling the gate instead of failing.
function blockNames(block) {
  const names = [block].flat();
  if (names.length === 0 || names.some((name) => typeof name !== "string" || name === "")) {
    throw new Error(`saga.headlessBlock must be a block name or a non-empty list of them, got ${JSON.stringify(block)}`);
  }
  return names;
}

/**
 * @param {{path: string, contents: string}[]} files
 * @param {{block?: string | string[], viewModules?: string[]}} [options]
 */
export function checkHeadlessPipelines(files, options = {}) {
  const blocks = blockNames(options.block ?? DEFAULT_BLOCK);
  const viewModules = options.viewModules ?? DEFAULT_VIEW_MODULES;
  const viewImport = new RegExp(`\\bfrom\\s+["'](?:${viewModules.map(escape).join("|")})["']`);
  const named = blocks.map((name) => ({
    name,
    matches: new RegExp(`(?:^|/)${escape(name)}\\.[cm]?[jt]sx?$`),
  }));

  const problems = [];
  for (const { path, contents } of files) {
    const hit = named.find(({ matches }) => matches.test(path));
    if (hit === undefined) continue;
    const block = hit.name;
    if (viewImport.test(contents)) {
      problems.push({
        path,
        rule: "headless-pipeline-no-view",
        detail: `${block} must stay headless and cannot import ${viewModules.join(" or ")}`,
      });
    }
    if (HOOK_IMPORT.test(contents)) {
      problems.push({
        path,
        rule: "headless-pipeline-no-hooks",
        detail: `${block} must stay headless and cannot import view hooks`,
      });
    }
  }
  return problems;
}
