// Only the public file may be imported across features. docs/architecture.md.

import path from "node:path";
import { escape, filenameOf, optionsOf, schemaOf } from "../options.mjs";

const DEFAULT_FEATURE_DIR = "features";
const DEFAULT_PUBLIC_FILE = "index";

function parser(featureDir) {
  const pattern = new RegExp(`(?:^|/)${escape(featureDir)}/([^/]+)(?:/(.+))?$`);
  return (candidate) => {
    const match = pattern.exec(candidate.replace(/\.[cm]?[jt]sx?$/, ""));
    return match ? { feature: match[1], rest: match[2] ?? "" } : null;
  };
}

/** A relative specifier only names a feature once resolved against the importer. */
function resolve(filename, source) {
  if (source.startsWith(".")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(filename), source));
  }
  return source;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "a feature exposes only its public file to other features" },
    schema: schemaOf({ featureDir: { type: "string" }, publicFile: { type: "string" } }),
    messages: {
      internal:
        "Importing '{{target}}' reaches inside feature '{{feature}}'. Import its {{publicFile}}, or ask for a kernel fragment.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const publicFile = options.publicFile ?? DEFAULT_PUBLIC_FILE;
    const parse = parser(options.featureDir ?? DEFAULT_FEATURE_DIR);
    const filename = filenameOf(context);
    const here = parse(filename);
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        const there = parse(resolve(filename, source));
        if (!there) return;
        if (here && here.feature === there.feature) return;
        if (there.rest === "" || there.rest === publicFile) return;
        context.report({
          node,
          messageId: "internal",
          data: { target: source, feature: there.feature, publicFile },
        });
      },
    };
  },
};
