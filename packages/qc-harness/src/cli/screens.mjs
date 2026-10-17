import path from "node:path";
import { parseArgs } from "node:util";
import { loadMap } from "../screens/map.mjs";
import { captureScreens } from "../screens/capture.mjs";
import { authStatus } from "../screens/stack-auth.mjs";

export const USAGE = `qc screens --map <json> --targets <left,right> --out <dir>
  [--only <screen,screen>] [--changed <target>] [--height <pixels>]
  [--timeout <milliseconds>] [--sign-in-timeout <milliseconds>]

Capture two targets at every map width. --changed captures one side and reuses the other.
Chrome must be installed. Browser sessions and copied profiles stay in ~/.qc/screens.`;

/** Trigger: capture screen pairs without loading the repository configuration. */
export async function runScreens(argv, { say = console.error } = {}) {
  const authCommand = argv[0] === "auth" && argv[1] === "status";
  if (authCommand) argv = argv.slice(2);
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: { map: { type: "string" }, targets: { type: "string" }, out: { type: "string" }, only: { type: "string" }, changed: { type: "string" }, height: { type: "string" }, timeout: { type: "string" }, "sign-in-timeout": { type: "string" }, help: { type: "boolean" } } }));
    if (values.help) { say(USAGE); return 0; }
    if (!values.map || (!authCommand && (!values.targets || !values.out))) throw new Error("--map, --targets, and --out are required");
    for (const field of ["height", "timeout", "sign-in-timeout"]) if (values[field] !== undefined && (!Number.isInteger(Number(values[field])) || Number(values[field]) < 1)) throw new Error(`--${field} must be a positive integer`);
  } catch (error) {
    say(`qc screens: ${error.message}\n${USAGE}`);
    return 2;
  }
  try {
    const map = loadMap(path.resolve(values.map));
    const { chromium } = await import("playwright");
    if (authCommand) {
      const rows = await authStatus(chromium, map.targets, { timeout: Number(values.timeout ?? 15000) });
      for (const row of rows) say(JSON.stringify(row));
      return 0;
    }
    const report = await captureScreens(map, { targets: values.targets.split(",").map(name => name.trim()), out: path.resolve(values.out), only: values.only, changed: values.changed, height: Number(values.height ?? 900), timeout: Number(values.timeout ?? 15000), signInTimeout: Number(values["sign-in-timeout"] ?? 180000) }, { chromium, say });
    for (const row of report) say(JSON.stringify(row));
    return 0;
  } catch (error) {
    say(`qc screens: ${error.message}`);
    return 1;
  }
}
