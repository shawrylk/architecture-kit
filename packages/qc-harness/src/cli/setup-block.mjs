export const CORE_BEGIN = "<!-- architecture-kit:begin core -->";
export const CORE_END = "<!-- architecture-kit:end core -->";

/** Fragment: replace or append the core block while preserving the surrounding text. */
export function applyBlock(text, block) {
  const begins = [...text.matchAll(new RegExp(`^[ \t]*${CORE_BEGIN}[ \t]*$`, "gm"))];
  const ends = [...text.matchAll(new RegExp(`^[ \t]*${CORE_END}[ \t]*$`, "gm"))];
  const absent = begins.length === 0 && ends.length === 0;
  if (!absent && (begins.length !== 1 || ends.length !== 1 || begins[0].index >= ends[0].index)) {
    throw new Error(`CLAUDE.md has ${begins.length} begin and ${ends.length} end markers; fix them by hand`);
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = block.replace(/\r\n?|\n/g, eol).trimEnd();
  const region = `${CORE_BEGIN}${eol}${body}${eol}${CORE_END}`;
  let result;
  if (absent) {
    const prefix = text === "" ? "" : `${text}${text.endsWith("\n") ? "" : eol}${eol}`;
    result = `${prefix}${region}${eol}`;
  } else {
    result = text.slice(0, begins[0].index) + region + text.slice(ends[0].index + ends[0][0].length);
  }
  return { text: result, changed: result !== text };
}
