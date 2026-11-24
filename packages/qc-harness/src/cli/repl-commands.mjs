// Read only the literal shell forms used by REPL. This scans text, including comments and strings;
// it never evaluates JavaScript. A malformed recognized form discards the whole scan.
const FORMS = /(?<![\w$.])\$\s*(?=`|\()|(?<![\w$.])tools\s*\.\s*Bash\s*\(\s*(?=\{)/g;
const SPACE = /\s/;
const ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
const invalid = () => { throw new SyntaxError("Incomplete REPL command literal"); };
const whitespace = (code, at) => { while (SPACE.test(code[at] ?? "") && at < code.length) at++; return at; };

function escapeAt(code, at) {
  const char = code[at + 1];
  if (char === undefined) return invalid();
  if (char === "\n") return ["", at + 2];
  if (char === "\r") return ["", at + (code[at + 2] === "\n" ? 3 : 2)];
  if (char === "x" || char === "u") {
    const braced = char === "u" && code[at + 2] === "{";
    const start = at + (braced ? 3 : 2);
    const end = braced ? code.indexOf("}", start) : start + (char === "x" ? 2 : 4);
    const digits = code.slice(start, end);
    if (end < start || !/^[\da-f]+$/i.test(digits) || (!braced && digits.length !== end - start)) return invalid();
    const value = Number.parseInt(digits, 16);
    if (value > 0x10ffff) return invalid();
    return [String.fromCodePoint(value), end + (braced ? 1 : 0)];
  }
  return [ESCAPES[char] ?? char, at + 2];
}

function literalAt(code, at) {
  const quote = code[at++];
  let value = "";
  while (at < code.length) {
    const char = code[at];
    if (char === quote) return [value, at + 1];
    if (char === "\\") {
      const escaped = escapeAt(code, at);
      value += escaped[0];
      at = escaped[1];
    } else if (quote === "`" && code.startsWith("${", at)) {
      at = groupEnd(code, at + 1);
      value += "QC_VALUE";
    } else {
      if (quote !== "`" && /[\r\n]/.test(char)) return invalid();
      value += char;
      at++;
    }
  }
  return invalid();
}

// Balance expression delimiters without interpreting the expression's value.
function groupEnd(code, at) {
  const close = { "{": "}", "(": ")", "[": "]" }[code[at++]];
  while (at < code.length) {
    const char = code[at];
    if (char === close) return at + 1;
    if ('\'"`'.includes(char)) at = literalAt(code, at)[1];
    else if ("{([".includes(char)) at = groupEnd(code, at);
    else if (code.startsWith("/*", at)) {
      const end = code.indexOf("*/", at + 2);
      if (end < 0) return invalid();
      at = end + 2;
    } else if (code.startsWith("//", at)) {
      const end = code.indexOf("\n", at + 2);
      at = end < 0 ? code.length : end + 1;
    } else at++;
  }
  return invalid();
}

function bashLiteral(code, at) {
  const end = groupEnd(code, at);
  at++;
  while (at < end - 1) {
    at = whitespace(code, at);
    const key = /^[\w$]+/.exec(code.slice(at))?.[0];
    if (key === "command") {
      let start = whitespace(code, at + key.length);
      if (code[start] === ":") {
        start = whitespace(code, start + 1);
        if (code[start] === '"' || code[start] === "'") {
          const [value, next] = literalAt(code, start);
          if ([",", "}"].includes(code[whitespace(code, next)])) return value;
        }
      }
    }
    // Skip a property value, so a nested object's command key is never mistaken for this one.
    while (at < end - 1 && code[at] !== ",") {
      if ('\'"`'.includes(code[at])) at = literalAt(code, at)[1];
      else if ("{([".includes(code[at])) at = groupEnd(code, at);
      else at++;
    }
    at++;
  }
  return null;
}

/** Shell commands in source order. Any error in the scan passes with no commands. */
export function replCommands(code) {
  if (typeof code !== "string") return [];
  try {
    const commands = [];
    for (const match of code.matchAll(FORMS)) {
      let at = match.index + match[0].length;
      let command = null;
      if (match[0].startsWith("tools")) command = bashLiteral(code, at);
      else if (code[at] === "`") command = literalAt(code, at)[0];
      else {
        at = whitespace(code, at + 1);
        if (code[at] === '"' || code[at] === "'") {
          const [value, end] = literalAt(code, at);
          if (code[whitespace(code, end)] === ")") command = value;
        }
      }
      if (command !== null) commands.push(command);
    }
    return commands;
  } catch {
    return [];
  }
}
