// A fragment: the `ui` block of the configuration, read once. Every path and threshold the UI tools
// use comes from here, so a repository names its own layout and the tools name none.

import { globMatcher } from "../glob.mjs";

/** @returns the `ui` block with its defaults filled in. */
export function uiOptions(config) {
  const ui = config.ui ?? {};
  return {
    componentRoots: ui.componentRoots ?? [],
    layers: ui.layers ?? {},
    catalog: ui.catalog ?? "docs/ui-catalog.md",
    catalogBaseline: ui.catalogBaseline ?? "ui-catalog.baseline.json",
    classCallees: ui.classCallees ?? ["cn", "clsx", "cva", "twMerge"],
    dupes: {
      minClassLength: ui.dupes?.minClassLength ?? 60,
      minFiles: ui.dupes?.minFiles ?? 3,
      baseline: ui.dupes?.baseline ?? "ui-dupes.baseline.json",
    },
  };
}

const TEST_OR_STORY = /\.(?:test|spec|stories|story)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//;
const TSX = /\.tsx$/;

/** True for a test or a story, which hold no component the catalog lists. */
export const isTestOrStory = (rel) => TEST_OR_STORY.test(rel);

/** A matcher for the `.tsx` files under the component roots, tests and stories excluded. */
export function componentFileMatcher(options) {
  const under = globMatcher(options.componentRoots.map((root) => `${root.replace(/\/+$/, "")}/**`));
  return (rel) => TSX.test(rel) && !isTestOrStory(rel) && under(rel);
}

/** `a/{b,c}/d` as `a/b/d` and `a/c/d`. One level of braces is all a client glob uses. */
export function expandBraces(glob) {
  const found = /\{([^{}]*)\}/.exec(glob);
  if (!found) return [glob];
  return found[1].split(",").flatMap((choice) => expandBraces(glob.slice(0, found.index) + choice + glob.slice(found.index + found[0].length)));
}
