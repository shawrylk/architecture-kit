// A fragment that reads a shell command the way the plugin's hooks need it: its segments, the git
// calls and directories in them, and whether any segment can write. It never runs the command.
// A command it cannot read counts as one that can write, so a guard that skips work skips safely.

/**
 * @typedef {{ words: string[], redirects: string[] }} Segment
 * `words` are unquoted; `redirects` are the targets of `>`, `>>` and `&>`.
 */

const BLANK = /[ \t]/;
/** The words that open a line of a compound command; the command after one is the command the line runs. */
const LINE_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "{", "!"]);
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
    while (LINE_KEYWORDS.has(words[0])) words.shift();
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

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const baseName = (word) => word.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, "");

/**
 * Skips the options of a wrapper, and each `NAME=value` word when `env` is given.
 * @param letters the short options that take a value, as the next word or the rest of their cluster
 * @param longs the long options that take the next word as their value
 * @returns the index of the first word that is no option of the wrapper
 */
function skipOptions(words, from, { letters = "", longs = [], env = null } = {}) {
  let i = from;
  while (i < words.length) {
    const word = words[i];
    const assignment = env && ASSIGNMENT.exec(word);
    if (assignment) {
      env[assignment[1]] = assignment[2];
      i++;
    } else if (word === "--") {
      i++;
    } else if (word.startsWith("--")) {
      i += longs.includes(word) ? 2 : 1;
    } else if (word.startsWith("-") && word.length > 1) {
      const at = [...word.slice(1)].findIndex((char) => letters.includes(char));
      i += at !== -1 && at === word.length - 2 ? 2 : 1;
    } else {
      break;
    }
  }
  return i;
}

/**
 * Each program that runs the command after its own options, and where that command starts: `env`, `sudo`,
 * `command`, `builtin`, `exec`, `doas`, `time`, `nice`, `ionice`, `stdbuf`, `setsid`, `nohup` and `timeout`.
 * `command -v` only looks a program up, so it returns -1 and is left as written.
 * `xargs` runs a command too, but the words it appends come from standard input, so no parse can follow it.
 */
const WRAPPERS = new Map([
  ["env", (words, from, env) => skipOptions(words, from, { letters: "uCSPa", longs: ["--unset", "--chdir", "--split-string", "--argv0"], env })],
  ["sudo", (words, from, env) => skipOptions(words, from, {
    letters: "ughpCDRTU",
    longs: ["--user", "--group", "--host", "--prompt", "--close-from", "--chdir", "--chroot", "--command-timeout", "--other-user"],
    env,
  })],
  ["command", (words, from) => {
    const end = skipOptions(words, from);
    return words.slice(from, end).some((word) => /^-[A-Za-z]*[vV]/.test(word)) ? -1 : end;
  }],
  ["time", (words, from) => skipOptions(words, from, { letters: "fo", longs: ["--format", "--output"] })],
  ["nohup", (words, from) => skipOptions(words, from)],
  ["exec", (words, from) => skipOptions(words, from, { letters: "a" })],
  ["nice", (words, from) => skipOptions(words, from, { letters: "n", longs: ["--adjustment"] })],
  ["ionice", (words, from) => skipOptions(words, from, { letters: "cnpPu", longs: ["--class", "--classdata", "--pid", "--pgid", "--uid"] })],
  ["stdbuf", (words, from) => skipOptions(words, from, { letters: "ioe", longs: ["--input", "--output", "--error"] })],
  ["setsid", (words, from) => skipOptions(words, from)],
  ["doas", (words, from) => skipOptions(words, from, { letters: "uC" })],
  ["builtin", (words, from) => skipOptions(words, from)],
  ["timeout", (words, from) => skipOptions(words, from, { letters: "sk", longs: ["--signal", "--kill-after"] }) + 1],
]);

/** The words of a command with its wrappers and its `NAME=value` prefixes removed, and the settings those made. */
function unwrap(words) {
  const env = {};
  let at = 0;
  for (;;) {
    for (let assignment; (assignment = ASSIGNMENT.exec(words[at] ?? "")); at++) env[assignment[1]] = assignment[2];
    const wrapper = at < words.length ? WRAPPERS.get(baseName(words[at])) : undefined;
    const next = wrapper?.(words, at + 1, env) ?? -1;
    if (next === -1) break;
    at = next;
  }
  return { words: words.slice(at), env };
}

/** The words of the command a segment runs: after any `NAME=value` assignments, and after each wrapper in `WRAPPERS`. */
export const commandWords = (segment) => unwrap(segment.words).words;

/** The `NAME=value` settings a segment makes for its command, before it and through `env` or `sudo`. */
export const commandEnv = (segment) => unwrap(segment.words).env;

const isGit = (word) => /(^|[\\/])git(\.exe)?$/i.test(word ?? "");

/**
 * @returns the git subcommand, each `-C` directory, each `-c` setting and the words after the subcommand, or null
 *   when the segment is no git call. `explicitDir` is true when the call names a git directory or a work tree, through
 *   `--git-dir`, `--work-tree`, `GIT_DIR` or `GIT_WORK_TREE`. It is never resolved: git reads a relative one from the
 *   working directory after every `-C`, so no later reader can know which repository it picks.
 */
export function gitCall(segment) {
  const [program, ...words] = commandWords(segment);
  if (!isGit(program)) return null;
  const { GIT_DIR, GIT_WORK_TREE } = commandEnv(segment);
  let explicitDir = Boolean(GIT_DIR || GIT_WORK_TREE);
  const dirs = [];
  const configs = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "-C") dirs.push(words[++i]);
    else if (word === "--git-dir" || word === "--work-tree") {
      explicitDir = true;
      i++;
    } else if (/^--(git-dir|work-tree)=/.test(word)) explicitDir = true;
    else if (word === "-c") configs.push(words[++i]);
    else if (!word.startsWith("-")) return { sub: word, dirs, explicitDir, configs, args: words.slice(i + 1) };
  }
  return { sub: null, dirs, explicitDir, configs, args: [] };
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
