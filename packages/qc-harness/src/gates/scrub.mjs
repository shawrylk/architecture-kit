// The source of a file with what is not code blanked, so a pattern cannot match a comment, a string or a
// regular expression. Every offset and newline stays, so an index in the result is an index in the source.

// A small lexer, so a quote inside a comment, a template or a regular expression starts nothing. It blanks
// what is not code, keeps every newline and offset, and leaves a string alone when `keepStrings` is set,
// because a specifier is one. A template's text goes, and the code in its `${}` stays. A `/` starts a
// regular expression after an operator or a keyword, and divides after a name or a closing bracket.
const TOKENS = /\/[/*]|["'`/]/g;
const TOKENS_IN_TEMPLATE = /\/[/*]|["'`/{}]/g;
const REGEX_AFTER = /(?:(?<![+-])[+-]|[(,=:[!&|?{};*%~^]|=>|(?<![\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await))\s*$/;

/** The index past the string that opens at `from`, or -1 when the line ends first. */
function stringEnd(source, from) {
  for (let i = from + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") i += 1;
    else if (ch === source[from]) return i + 1;
    else if (ch === "\n") return -1;
  }
  return -1;
}

/** The index past the regular expression that opens at `from`, or -1 when it is not one. */
function regexEnd(source, from) {
  let inClass = false;
  for (let i = from + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\n") return -1;
    if (ch === "\\") i += 1;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      let end = i + 1;
      while (end < source.length && /[a-z]/.test(source[end])) end += 1;
      return end;
    }
  }
  return -1;
}

/** The end of a template's text from `from`, and whether a `${` opened an expression there. */
function templateEnd(source, from) {
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") i += 1;
    else if (ch === "`") return [i + 1, false];
    else if (ch === "$" && source[i + 1] === "{") return [i + 2, true];
  }
  return [source.length, false];
}

export function scrub(source, keepStrings) {
  const pieces = [];
  let copied = 0;
  const blank = (from, to) => {
    pieces.push(source.slice(copied, from));
    const dead = source.slice(from, to);
    pieces.push(dead.includes("\n") ? dead.replace(/[^\n]/g, " ") : " ".repeat(to - from));
    copied = to;
  };
  const expressions = [];
  let depth = 0;
  let pattern = TOKENS;
  let at = 0;
  for (;;) {
    pattern.lastIndex = at;
    const match = pattern.exec(source);
    if (match === null) break;
    const start = match.index;
    const token = match[0];
    at = start + token.length;
    if (token === "//") {
      const end = source.indexOf("\n", at);
      at = end === -1 ? source.length : end;
      blank(start, at);
    } else if (token === "/*") {
      const close = source.indexOf("*/", at);
      at = close === -1 ? source.length : close + 2;
      blank(start, at);
    } else if (token === "/") {
      const end = start === 0 || REGEX_AFTER.test(source.slice(Math.max(0, start - 20), start)) ? regexEnd(source, start) : -1;
      if (end !== -1) {
        blank(start, end);
        at = end;
      }
    } else if (token === "{") {
      depth += 1;
    } else if (token === "}" && !(expressions.length > 0 && depth === expressions.at(-1))) {
      depth -= 1;
    } else if (token === "`" || token === "}") {
      if (token === "}") expressions.pop();
      const [end, opened] = templateEnd(source, at);
      blank(start, end);
      at = end;
      if (opened) expressions.push(depth);
      pattern = expressions.length > 0 ? TOKENS_IN_TEMPLATE : TOKENS;
    } else {
      const end = stringEnd(source, start);
      if (end !== -1) {
        if (!keepStrings) blank(start, end);
        at = end;
      }
    }
  }
  if (pieces.length === 0) return source;
  pieces.push(source.slice(copied));
  return pieces.join("");
}
