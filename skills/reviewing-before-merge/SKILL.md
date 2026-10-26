---
name: reviewing-before-merge
description: "Use when the user runs /code-review on a pull request, when a repository ships its own review skill, or when deciding whether a pull request needs a review before it merges."
---

# Review the work before you merge it

**Status: suspended.** Do not run `/code-review` on your own, for any pull request, in any
repository. The user triggers it manually, on the pull requests they pick for quality control.
The rest of this section states the rule for when the user resumes it; follow the status line
until then.

**Run `/code-review` against the pull request before it merges. Every repository, every pull
request.** A one-line fix counts. A documentation change counts. Your own branch counts.

**Why.** CI answers one question, and answers it well: the code builds, the types hold, the tests
pass. It reads none of the five categories the review reads for: security, performance, code
quality, testing and architecture. A review nobody has to run is a review that runs when somebody
remembers, which is never the pull request that needed it. The user suspended the automatic form
of this rule to favor fast, cheap iteration during early development, and runs the review
manually instead.

**How to apply:**

- While the status line says suspended, do not call `/code-review` on your own initiative, even
  after CI turns green.
- When the user runs `/code-review <pr-number>` themselves, follow the steps below.
- Run `/code-review <pr-number>` once CI is green. The number makes the review read the merged
  diff, not your working tree.
- Fix every finding, or answer it in the thread. A finding you disagree with gets a reason, not
  silence.
- Re-run the review after a fix that changes behaviour.
- Where the repository ships its own review skill, such as `/review-code`, that satisfies the same
  bar. Run one review, not two.
- **Keep this bar local.** Do not add it to a shared rules file or propose it as a repository rule.
  Each developer runs their own workflow, and this one is yours.

**The one exemption (once resumed):** a pull request you neither wrote nor merge, such as one you
only approve.
