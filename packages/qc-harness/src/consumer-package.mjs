// A resource that loads optional packages from the consumer's installation.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function importConsumerPackage(name, root = process.cwd()) {
  for (const start of [root, path.dirname(fileURLToPath(import.meta.url))]) {
    for (let directory = path.resolve(start); ; directory = path.dirname(directory)) {
      const manifest = path.join(directory, "node_modules", name, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        let entry = pkg.exports?.["."] ?? pkg.exports ?? pkg.main ?? "index.js";
        while (entry && typeof entry === "object") entry = entry.node ?? entry.import ?? entry.default;
        if (typeof entry === "string") return import(pathToFileURL(path.resolve(path.dirname(manifest), entry)).href);
      }
      if (path.dirname(directory) === directory) break;
    }
  }
  return import(pathToFileURL(createRequire(path.join(root, "package.json")).resolve(name)).href);
}
