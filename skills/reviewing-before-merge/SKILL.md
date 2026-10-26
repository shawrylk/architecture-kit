---
name: reviewing-before-merge
description: "Use when the user runs /code-review on a pull request, when a repository ships its own review skill, or when deciding whether a pull request needs a review before it merges."
---

# Review the work before you merge it

**Run `/code-review` against the pull request before it merges. Every repository, every pull
request.** A one-line fix counts. A documentation change counts. Your own branch counts.

**Why.** CI answers one question, and answers it well: the code builds, the types hold, the tests
pass. It reads none of the five categories the review reads for: security, performance, code
quality, testing and architecture. A review nobody has to run is a review that runs when somebody
remembers, which is never the pull request that needed it.

**How to apply:**

- Where a guard denies the `/code-review` skill, dispatch `architecture:sdd-branch-reviewer`, or ask the user to type `/code-review`.
- Run `/code-review <pr-number>` once CI is green. The number makes the review read the merged
  diff, not your working tree.
- Fix every finding, or answer it in the thread. A finding you disagree with gets a reason, not
  silence.
- Re-run the review after a fix that changes behaviour.
- Where the repository ships its own review skill, such as `/review-code`, that satisfies the same
  bar. Run one review, not two.

**The one exemption:** a pull request you neither wrote nor merge, such as one you
only approve.
