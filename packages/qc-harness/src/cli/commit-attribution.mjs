// A commit message records who is accountable for a change. A tool is not, and a trailer naming
// one adds a co-author who cannot answer a question about the code. The rule is widely stated and
// widely ignored, because nothing checks it -- so this checks it, at the one moment it is cheap.

const TRAILER = /^\s*(?:co-authored-by|signed-off-by|assisted-by|generated-by)\s*:\s*(.+)$/i;

const DEFAULT_TOOLS = [
  "claude",
  "anthropic",
  "copilot",
  "chatgpt",
  "openai",
  "gpt-4",
  "gpt-5",
  "gemini",
  "cursor",
  "codeium",
  "devin",
  "aider",
  "windsurf",
  "bot@",
  "noreply@anthropic.com",
];

// A marketing footer is the other half of the same habit.
const DEFAULT_FOOTERS = [/generated with .*claude/i, /co-?authored by .*(claude|copilot|chatgpt)/i, /🤖/u];

/**
 * @param {string} message the full commit message
 * @param {{tools?: string[], footers?: RegExp[]}} [options]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkCommitAttribution(message, options = {}) {
  const tools = (options.tools ?? DEFAULT_TOOLS).map((name) => name.toLowerCase());
  const footers = options.footers ?? DEFAULT_FOOTERS;
  const problems = [];

  message.split("\n").forEach((line, index) => {
    const trailer = TRAILER.exec(line);
    if (trailer) {
      const value = trailer[1].toLowerCase();
      const tool = tools.find((name) => value.includes(name));
      if (tool) {
        problems.push({
          path: "COMMIT_MSG",
          rule: "tool-as-author",
          detail: `line ${index + 1} credits "${trailer[1].trim()}". A tool is not an author — the committer is accountable for the change.`,
        });
      }
      return;
    }
    if (footers.some((pattern) => pattern.test(line))) {
      problems.push({
        path: "COMMIT_MSG",
        rule: "tool-footer",
        detail: `line ${index + 1} advertises the tool that wrote the change. The message says what changed and why, nothing else.`,
      });
    }
  });
  return problems;
}

/** Strips every line the check would reject, for `--fix` and for rewriting an unpushed branch. */
export function withoutAttribution(message, options = {}) {
  const rejected = new Set(checkCommitAttribution(message, options).map((problem) => problem.detail.match(/^line (\d+)/)[1]));
  const kept = message.split("\n").filter((_, index) => !rejected.has(String(index + 1)));
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
