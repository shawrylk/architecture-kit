// The package surface. A consumer imports the preset and the config; the gates are
// reachable individually for a repository that wants to run one on its own.

export { load, defaults, merge, thresholds, enabled, CONFIG_FILE } from "./config.mjs";
export { preset } from "./eslint/preset.mjs";
export { default as plugin, rules } from "./eslint/index.mjs";
export { gateDescriptions, describedGates } from "./descriptions.mjs";
export { runCheck } from "./cli/check.mjs";
export { enforcementMap, withEnforcementMap, OPEN as ENFORCEMENT_MAP_OPEN, CLOSE as ENFORCEMENT_MAP_CLOSE } from "./enforcement-map.mjs";
