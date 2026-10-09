// A brief file for a test that dispatches an implementer: the task gate reads the file on the `Brief:` line.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "qc-test-brief-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** The path of a brief that holds a `## Product decisions` section. */
export const BRIEF = path.join(dir, "brief.md");
writeFileSync(BRIEF, "# Brief\n\n## Product decisions\n\nNone.\n");
