import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";

/** @typedef {{read(ref: string): string, write(ref: string, text: string): void, list(): string[]}} PlanStore */
// Another store, such as an issue body, can use these same three methods.
export function filePlanStore(root, dir = "docs/plans") {
  root = path.resolve(root);
  const inside = (base, file) => { const relative = path.relative(base, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  const resolve = (ref) => {
    const file = path.resolve(root, ref.replace(/\\/g, "/"));
    if (!inside(root, file)) throw new Error(`${ref} is outside ${root}`);
    let ancestor = file;
    while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
    if (!inside(realpathSync(root), realpathSync(ancestor))) throw new Error(`${ref} is outside ${root}`);
    return file;
  };
  return {
    read(ref) { return readFileSync(resolve(ref), "utf8"); },
    write(ref, text) {
      const file = resolve(ref);
      mkdirSync(path.dirname(file), { recursive: true });
      const temp = resolve(`${ref}.tmp`);
      writeFileSync(temp, text, "utf8");
      renameSync(temp, file);
    },
    list() {
      const folder = resolve(dir);
      let entries;
      try { entries = readdirSync(folder, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => path.relative(root, path.join(folder, entry.name)).replace(/\\/g, "/")).sort();
    },
  };
}
