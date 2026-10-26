/** Branch: validate switch declarations so unwired controls keep their importers in JSX. */
export function checkFeatureSwitches(files, options, featureRoot) {
  const patterns = options.patterns.map((pattern) => new RegExp(pattern));
  const switchPath = featureRoot === undefined ? null : `${featureRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/${options.file}`;
  const problems = [];
  for (const file of files) {
    if (file.path.replace(/\\/g, "/") === switchPath) continue;
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
