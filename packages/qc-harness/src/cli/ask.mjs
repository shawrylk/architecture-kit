import { runGhResult } from "./gh-run.mjs";
import { originOf } from "./git-read.mjs";

const USAGE = 'Usage: qc ask --issue <n> "<question>"';

/** Label an issue and post one question in the checkout's repository. */
export function askIssue(issue, question, { cwd = process.cwd(), repo = originOf(cwd), gh } = {}) {
  if (!/^[1-9]\d*$/.test(String(issue)) || typeof question !== "string" || !question.trim()) throw new Error(USAGE);
  if (!repo) throw new Error("qc ask: cannot read the repository from origin");
  const invoke = (args) => {
    const command = [...args, "-R", repo];
    if (gh) {
      const answer = gh(command);
      if (answer == null) throw new Error("gh returned no answer");
      return answer;
    }
    const result = runGhResult(command, { cwd });
    if (result.status !== 0) throw new Error((result.stderr?.trim() || result.error?.message || `gh exited ${result.status}`).split(/\r?\n/)[0]);
    return result.stdout;
  };
  const labels = JSON.parse(invoke(["label", "list", "--search", "needs-user", "--json", "name", "--limit", "100"]));
  if (!labels.some((label) => label.name === "needs-user")) {
    invoke(["label", "create", "needs-user", "--color", "D876E3", "--description", "Needs an answer from the user"]);
  }
  invoke(["issue", "edit", String(issue), "--add-label", "needs-user"]);
  invoke(["issue", "comment", String(issue), "--body", question]);
}

/** `qc ask --issue <n> "<question>"`. */
export function runAsk(args, { warn = console.error, ...deps } = {}) {
  if (args.length !== 3 || args[0] !== "--issue" || !/^[1-9]\d*$/.test(args[1]) || !args[2].trim() || args[2].startsWith("--")) {
    warn(USAGE);
    return 1;
  }
  try {
    askIssue(args[1], args[2], deps);
    return 0;
  } catch (error) {
    warn(String(error.message).split(/\r?\n/)[0]);
    return 1;
  }
}
