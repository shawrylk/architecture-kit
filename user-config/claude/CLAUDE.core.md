## Rules that live in skills

Each rule below is a skill the `architecture` plugin ships. Load it with the Skill tool at its trigger, and follow it exactly. The skill is the rule; this file only names it and says when. A subagent loads the same skills.

| Skill | Load it |
|---|---|
| `architecture:registering-work` | Before the first edit of any task in a repository that has an issue tracker |
| `architecture:reviewing-before-merge` | When the user runs `/code-review`, or before you decide that a pull request needs a review |
| `architecture:writing-plain-english` | Before you write documentation, an ADR, a commit message, a pull request or issue body, an issue comment, or a code comment |
| `architecture:applying-engineering-standards` | Before you design, write, refactor, or review code |
| `architecture:navigating-source-code` | Before you explore code you have not read, to find a concept, a symbol's callers, or a change's blast radius |
| `architecture:writing-decision-final-specs` | Before you write or change a specification, an ADR, a contract in `schemas/`, a requirements register, or a Docusaurus docs site |

## Always on

- **Register the work.** Open a GitHub issue before the first edit of every task, in every repository that has an issue tracker. A small fix counts. `architecture:registering-work` has the details.
- **Review before merge.** Every pull request gets a review before it merges. `architecture:reviewing-before-merge` has the details.
- **Prose in every reply.** `architecture:writing-plain-english` is the full standard. Every reply follows this core:
  - Lead with the answer or the result. Write no preamble, never restate the request, and do not close with a summary.
  - A step is one instruction in 20 words at most. A descriptive sentence is 25 words at most. One topic per sentence.
  - Use the active voice and the simple tenses. Keep the article.
  - State what is true: no litotes, and one negative per sentence at most.
  - Use the plainest word: "use", not "utilize"; "before", not "prior to"; "to", not "in order to". Delete `simply`, `just`, `easily`, `obviously`, `basically`, `actually`, `very`, `quite`, and `really`.
  - Address the reader as "you", never "we". Never write "please" in an instruction, and never use a slash for "and" or "or".
  - Use code font for code, paths, commands, and identifiers. Use the serial comma and sentence-case headings.
  - Use a table for three or more parallel facts.
  - Write timeless prose: no progress, no revision history, and no dates. An ADR, a changelog, a commit message, and a direct answer about what you did are the exceptions.
  - Exempt: quoted text, Japanese UI strings, code identifiers, and thinking.
