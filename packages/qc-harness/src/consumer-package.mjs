// A resource that loads optional packages from the consumer's installation.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OPTIONAL_PEERS = new Set(["yaml", "playwright", "pngjs", "pixelmatch"]);

export async function importConsumerPackage(name, root = process.cwd()) {
  if (!OPTIONAL_PEERS.has(name)) throw new Error(`Unsupported optional peer '${name}'`);
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
  let resolved;
  try {
    resolved = createRequire(path.join(root, "package.json")).resolve(name);
  } catch (cause) {
    if (cause.code !== "MODULE_NOT_FOUND" || cause.message.split("\n")[0] !== `Cannot find module '${name}'`) throw cause;
    throw Object.assign(new Error(`Cannot find package '${name}'`, { cause }), { code: "ERR_MODULE_NOT_FOUND" });
  }
  return import(pathToFileURL(resolved).href);
}
