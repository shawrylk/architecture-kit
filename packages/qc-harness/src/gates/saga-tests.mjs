// A headless architecture is a claim until something checks it. The two lint-side
// rules keep orchestration out of the view and the view out of the pipeline; neither
// proves a workflow is ever *run* without one. This does.
//
// It asserts a saga is named by a test that imports no view module — not that the
// test is good. Whether the test proves the workflow is what review is for.

const DEFAULT_FACTORIES = ["definePipeline", "defineSaga"];
const DEFAULT_VIEW_MODULES = ["react", "react-dom"];

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every saga a source file exports, by the factory that declares it.
 *
 * @param {{path: string, contents: string}[]} files
 * @param {{factories?: string[]}} [options]
 * @returns {{path: string, name: string}[]}
 */
export function declaredSagas(files, options = {}) {
  const factories = (options.factories ?? DEFAULT_FACTORIES).map(escape).join("|");
  const declaration = new RegExp(`export\\s+const\\s+(\\w+)\\s*=\\s*(?:${factories})\\s*[<(]`, "g");
  const found = [];
  for (const { path, contents } of files) {
    declaration.lastIndex = 0;
    let match = declaration.exec(contents);
    while (match !== null) {
      found.push({ path, name: match[1] });
      match = declaration.exec(contents);
    }
  }
  return found;
}

/**
 * Every name a test could use to reach this saga: the saga itself, and any exported
 * function in the same file whose body names it. A runner is one indirection and is
 * followed — a check that cries wolf is a check somebody turns off.
 */
export function entryPoints(source, saga) {
  const names = [saga];
  const named = new RegExp(`\\b${escape(saga)}\\b`);
  // Top-level exports, each chunk running to the next one.
  const chunks = source.split(/\nexport\s+/);
  for (const chunk of chunks) {
    const declared = /^(?:async\s+)?function\s+(\w+)|^const\s+(\w+)\s*=/.exec(chunk);
    if (!declared) continue;
    const name = declared[1] ?? declared[2];
    if (name === saga) continue;
    if (named.test(chunk)) names.push(name);
  }
  return names;
}

/** A test that reaches for the view layer is not the proof this gate is asking for. */
function isHeadless(contents, viewModules) {
  const viewImport = new RegExp(`\\bfrom\\s+["'](?:${viewModules.map(escape).join("|")})["']`);
  return !viewImport.test(contents);
}

/**
 * @param {{path: string, name: string}[]} sagas
 * @param {{path: string, contents: string}[]} tests
 * @param {{viewModules?: string[]}} [options]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkSagaTests(sagas, tests, options = {}) {
  const viewModules = options.viewModules ?? DEFAULT_VIEW_MODULES;
  const bySource = new Map(options.sources?.map((file) => [file.path, file.contents]) ?? []);
  const problems = [];
  for (const { path, name } of sagas) {
    const reachable = entryPoints(bySource.get(path) ?? "", name);
    const named = new RegExp(`\\b(?:${reachable.map(escape).join("|")})\\b`);
    const naming = tests.filter((test) => named.test(test.contents));
    if (naming.length === 0) {
      problems.push({
        path,
        rule: "untested-saga",
        detail: `'${name}' is never named by a test, nor is any runner that calls it — nothing runs it without a browser`,
      });
      continue;
    }
    if (!naming.some((test) => isHeadless(test.contents, viewModules))) {
      problems.push({
        path,
        rule: "view-bound-saga",
        detail: `every test naming '${name}' imports ${viewModules.join(" or ")} — none proves it runs headlessly`,
      });
    }
  }
  return problems;
}
