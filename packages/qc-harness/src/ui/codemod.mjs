// A refactor that rewrites class tokens across a frontend in one command. A token is replaced whole,
// keeping its variant prefixes and its `!` modifier. Only class sites change (class-sites.mjs), and the
// edit is by source range, so the rest of the file keeps its formatting.

import { classTokensOf } from "./class-sites.mjs";
import { parseSource } from "./typescript.mjs";

const BREAKS_A_STRING = /["'`\\\n\r]|\$\{/;
const ARBITRARY = /^-?[a-z][a-z0-9-]*-\[[^\]\s]+\](?:\/[\w.%[\]-]+)?$/i;

/** Splits `md:hover:!text-[11px]` into its variant prefix, its `!` modifier and its core. A colon in brackets is no variant. */
export function splitToken(token) {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index];
    if (character === "[" || character === "(") depth += 1;
    else if (character === "]" || character === ")") depth -= 1;
    else if (character === ":" && depth === 0) cut = index;
  }
  const prefix = token.slice(0, cut + 1);
  let core = token.slice(cut + 1);
  const lead = core.startsWith("!") ? "!" : "";
  core = core.slice(lead.length);
  const trail = !lead && core.endsWith("!") ? "!" : "";
  return { prefix, lead, trail, core: trail ? core.slice(0, -1) : core };
}

/** The token after the map, or the token itself when the map holds neither it nor its core. */
export function rewriteToken(token, map) {
  const whole = Object.hasOwn(map, token) ? map[token] : null;
  const { prefix, lead, trail, core } = splitToken(token);
  const replacement = whole ?? (Object.hasOwn(map, core) ? map[core] : null);
  if (replacement === null) return token;
  if (whole !== null) return whole;
  return replacement
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${prefix}${lead}${part}${trail}`)
    .join(" ");
}

/** The map `--map` carries: class tokens to the tokens that replace them. */
export function parseMap(json) {
  let map;
  try {
    map = JSON.parse(json);
  } catch (cause) {
    throw new Error(`--map is not valid JSON: ${cause.message}`);
  }
  if (map === null || typeof map !== "object" || Array.isArray(map)) throw new Error("--map is a JSON object of token to token");
  for (const [from, to] of Object.entries(map)) {
    if (typeof to !== "string") throw new Error(`--map: the replacement of ${from} is not a string`);
    if (BREAKS_A_STRING.test(to) || BREAKS_A_STRING.test(from)) {
      throw new Error(`--map: ${from} or its replacement holds a quote, a backtick, a backslash or a line break`);
    }
  }
  return map;
}

/** @returns {{text: string, count: number}} the source with each class token mapped, and how many changed */
export function codemodSource(ts, name, text, map, callees) {
  const edits = [];
  for (const token of classTokensOf(ts, parseSource(ts, name, text), callees)) {
    const next = rewriteToken(token.text, map);
    if (next !== token.text) edits.push({ ...token, next });
  }
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.next + out.slice(edit.end);
  return { text: out, count: edits.length };
}

/** @returns {Map<string, number>} each arbitrary-value token of a source with its uses, in first-use order */
export function arbitraryTokens(ts, name, text, callees) {
  const counts = new Map();
  for (const token of classTokensOf(ts, parseSource(ts, name, text), callees)) {
    const { core } = splitToken(token.text);
    if (ARBITRARY.test(core)) counts.set(core, (counts.get(core) ?? 0) + 1);
  }
  return counts;
}

/** Each custom property declared inside an `@theme` block of a stylesheet. */
export function themeVariables(css) {
  const variables = [];
  for (const block of css.matchAll(/@theme\b[^{]*\{/g)) {
    let depth = 1;
    let index = block.index + block[0].length;
    const start = index;
    while (index < css.length && depth > 0) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") depth -= 1;
      index += 1;
    }
    for (const found of css.slice(start, index - 1).matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
      variables.push({ name: found[1], value: found[2].trim() });
    }
  }
  return variables;
}

/** A comparable value: lowercase, one space between parts, and a `rem` length as pixels. */
function comparable(value) {
  const flat = value.trim().toLowerCase().replace(/\s*!important$/, "").replace(/\s+/g, " ");
  return flat.replace(/^(-?\d*\.?\d+)rem$/, (_, number) => `${Math.round(Number(number) * 16 * 1e4) / 1e4}px`);
}

const NAMESPACES = {
  text: ["text", "color"],
  rounded: ["radius"],
  shadow: ["shadow"],
  leading: ["leading"],
  tracking: ["tracking"],
  font: ["font"],
  blur: ["blur"],
  bg: ["color"],
  border: ["color"],
  ring: ["color"],
  fill: ["color"],
  stroke: ["color"],
};

/**
 * Each arbitrary token with the theme variable that holds its value, most used first.
 * @param {Map<string, number>} counts
 * @param {{name: string, value: string}[]} theme
 */
export function suggest(counts, theme) {
  const ordered = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ordered.map(([token, count]) => {
    const [, utility, inside] = /^-?([a-z][a-z0-9-]*?)-\[([^\]]+)\]/i.exec(token) ?? [];
    const wanted = inside === undefined ? null : comparable(inside.replace(/_/g, " "));
    const same = theme.filter((one) => wanted !== null && comparable(one.value) === wanted);
    const spaces = NAMESPACES[utility?.split("-")[0]] ?? [];
    const best = same.find((one) => spaces.some((space) => one.name.startsWith(`--${space}-`))) ?? same[0] ?? null;
    return { token, count, variable: best?.name ?? null, value: best?.value ?? null };
  });
}
