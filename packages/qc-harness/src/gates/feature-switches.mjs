import path from "node:path";

/** Branch: validate switch declarations so unwired controls keep their importers in JSX. */
export function checkFeatureSwitches(files, options) {
  const patterns = options.patterns.map((pattern) => new RegExp(pattern));
  const problems = [];
  for (const file of files) {
    if (path.basename(file.path) === options.file) continue;
    const declarations = /^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm;
    for (const [, name] of file.contents.matchAll(declarations)) {
      if (!patterns.some((pattern) => pattern.test(name))) continue;
      problems.push({
        path: file.path,
        rule: "unwire-constant-outside-switch-file",
        detail: `${name} belongs in ${options.file}, beside the feature's other switches`,
      });
    }
  }
  return problems;
}
