// A pipeline that stages the root user configuration for the npm package.

import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function packageUserConfig(source, target) {
  for (const file of ["claude/CLAUDE.core.md", "claude/statusline.js", "claude/settings.shared.json", "codex/config.shared.toml"]) {
    mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    copyFileSync(path.join(source, file), path.join(target, file));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageUserConfig(fileURLToPath(new URL("../../../../user-config/", import.meta.url)), fileURLToPath(new URL("../../user-config/", import.meta.url)));
}
