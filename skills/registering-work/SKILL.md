---
name: registering-work
description: "Use when starting any task in a repository that has an issue tracker, before the first edit, including a small fix, a review follow-up, or a request typed straight into chat, and when work has merged with no issue behind it."
---

# Register the work before you start it

**Open a GitHub issue before the first edit. Every task, in every repository that has an issue
tracker.** A small fix counts. A review follow-up counts. A request the user types straight into the
chat counts. If the user names no issue, file one, then work.

**Why.** A merged pull request with no issue behind it leaves the work untracked.
Register the work before the first edit so the issue records its scope and outcome.

**How to apply:**

- Run `gh issue create` before you touch code. Give it a title in the repository's commit style, and
  a body that carries the request in the user's own words.
- Reference the issue from the pull request body. Use `Refs #<n>` where a workflow owns closing, and
  `Fixes #<n>` only where merging is meant to close the issue.
- Name the issue in the branch when the repository expects it.
- When the user asks for work mid-conversation and names no issue, say you are filing one and file
  it. Do not ask whether it is worth it.
- When work has already merged with no issue, offer the backfill once, then take the answer.

**The one exemption:** a repository with issues turned off. Ask the user where to register the work
instead.
