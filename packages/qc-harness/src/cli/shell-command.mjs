// A fragment that reads a shell command the way the plugin's hooks need it: its segments, the git
// calls and directories in them, and whether any segment can write. It never runs the command.
// A command it cannot read counts as one that can write, so a guard that skips work skips safely.

/**
 * @typedef {{ words: string[], redirects: string[] }} Segment
 * `words` are unquoted; `redirects` are the targets of `>`, `>>` and `&>`.
 */

const BLANK = /[ \t]/;
const WORD_END = /[\s;&|<>()]/;

/** Skips each pending heredoc body after a newline. @returns the index after the last body. */
function skipHeredocs(command, start, heredocs) {
  let i = start;
  for (const { delimiter, strip } of heredocs) {
    while (i < command.length) {
      const end = command.indexOf("\n", i);
      const stop = end === -1 ? command.length : end;
      const line = command.slice(i, stop).replace(/\r$/, "");
      i = stop + 1;
      if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
    }
  }
  return i;
}

const POSIX_ESCAPE = "\\";

/**
 * @param dialect `escape` is the escape character: a backslash for a POSIX shell, a backtick for PowerShell.
 * @returns {Segment[]} the segments between unquoted `;`, `&`, `&&`, `|`, `||`, parentheses and newlines.
 */
export function segmentsOf(command, { escape = POSIX_ESCAPE } = {}) {
  const segments = [];
  let words = [];
  let redirects = [];
  let word = "";
  let inWord = false;
  let quote = null;
  let target = null;
  let heredocs = [];

  const endWord = () => {
    if (!inWord) return;
    if (target === "out") redirects.push(word);
    else if (target !== "in") words.push(word);
    target = null;
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects });
    words = [];
    redirects = [];
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      i++;
    } else if (quote === '"') {
      // Inside double quotes a backslash escapes only these, so a Windows path keeps its separators.
      // A backtick escapes any character.
      if (c === escape && next !== undefined && (escape !== POSIX_ESCAPE || '$`"\\\n'.includes(next))) {
        word += next;
        i += 2;
      } else {
        if (c === '"') quote = null;
        else word += c;
        i++;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      i++;
    } else if (c === escape) {
      if (next !== "\n") word += next ?? "";
      inWord = next !== "\n" || inWord;
      i += 2;
    } else if (c === "\n") {
      endSegment();
      i = skipHeredocs(command, i + 1, heredocs);
      heredocs = [];
    } else if (BLANK.test(c) || c === "\r") {
      endWord();
      i++;
    } else if (c === ";" || c === "(" || c === ")") {
      endSegment();
      i++;
    } else if (c === "|") {
      endSegment();
      i += next === "|" ? 2 : 1;
    } else if (c === "&") {
      if (next === ">") {
        endWord();
        target = "out";
        i += command[i + 2] === ">" ? 3 : 2;
      } else {
        endSegment();
        i += next === "&" ? 2 : 1;
      }
    } else if (c === ">") {
      // A leading descriptor number belongs to the operator, as in `2>file`.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      i += next === ">" ? 2 : 1;
      if (command[i] === "&") {
        i++;
        while (/[\d-]/.test(command[i] ?? "")) i++;
      } else {
        target = "out";
      }
    } else if (c === "<") {
      endWord();
      if (next === "<" && command[i + 2] !== "<") {
        i += 2;
        const strip = command[i] === "-";
        if (strip) i++;
        while (BLANK.test(command[i] ?? "")) i++;
        let delimiter = "";
        while (i < command.length && !WORD_END.test(command[i])) {
          if (!`'"\\`.includes(command[i])) delimiter += command[i];
          i++;
        }
        heredocs.push({ delimiter, strip });
      } else {
        i += next === "<" ? 3 : 1;
        target = "in";
      }
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endSegment();
  return segments;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The words after any leading `NAME=value` assignments. */
export const commandWords = (segment) => {
  const start = segment.words.findIndex((word) => !ASSIGNMENT.test(word));
  return start === -1 ? [] : segment.words.slice(start);
};

const isGit = (word) => /(^|[\\/])git(\.exe)?$/i.test(word ?? "");

/**
 * @returns the git subcommand, each `-C` directory, each `-c` setting and the words after the
 *   subcommand, or null when the segment is no git call.
 */
export function gitCall(segment) {
  const [program, ...words] = commandWords(segment);
  if (!isGit(program)) return null;
  const dirs = [];
  const configs = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "-C") dirs.push(words[++i]);
    else if (word === "-c") configs.push(words[++i]);
    else if (!word.startsWith("-")) return { sub: word, dirs, configs, args: words.slice(i + 1) };
  }
  return { sub: null, dirs, configs, args: [] };
}

/** @returns the directory a `cd` or `pushd` segment moves to, or null. */
export function cdTarget(segment) {
  const [program, target] = commandWords(segment);
  return program === "cd" || program === "pushd" ? (target ?? "~") : null;
}

const READ_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "pwd", "echo", "printf",
  "cut", "tr", "jq", "which", "type", "stat", "file", "du", "df", "date", "basename",
  "dirname", "realpath", "readlink", "diff", "cmp", "true", "false", "test", "[", "popd",
]);
export const GIT_READS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "blame", "branch", "remote",
  "fetch", "describe", "shortlog", "config",
]);
const SED_IN_PLACE = /^(-[A-Za-z]*i|--in-place)/;

/** True when the segment writes a file through a redirect other than the null device. */
export const writesRedirect = (segment) => segment.redirects.some((file) => file !== "/dev/null");

/** True when one segment only reads, or only moves between directories. */
export function isReadOnly(segment) {
  if (writesRedirect(segment)) return false;
  if (cdTarget(segment) !== null) return true;
  const git = gitCall(segment);
  if (git) return GIT_READS.has(git.sub);
  const [program, ...args] = commandWords(segment);
  if (program === "sed") return !args.some((arg) => SED_IN_PLACE.test(arg));
  return READ_PROGRAMS.has(program);
}

/** False only when every segment is known to read, so an unknown program counts as a write. */
export const mayWrite = (command) => !segmentsOf(command).every(isReadOnly);

/** Every directory the command names through `cd` or `git -C`, in order, as written. */
export function checkoutDirs(command) {
  const dirs = [];
  for (const segment of segmentsOf(command)) {
    const cd = cdTarget(segment);
    if (cd !== null) dirs.push(cd);
    dirs.push(...(gitCall(segment)?.dirs ?? []).filter(Boolean));
  }
  return dirs;
}
