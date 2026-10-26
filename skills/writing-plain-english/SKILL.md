---
name: writing-plain-english
description: "Use when writing documentation, a docs/** page, an ADR, a commit message, a pull request or issue body, an issue comment, a code comment, or a chat reply longer than a few lines, and when checking prose against Simplified Technical English (ASD-STE100) or the Google developer documentation style."
---

# Prose style: Simplified Technical English

Provenance: ASD-STE100 (Simplified Technical English) for sentences, and the Google developer
documentation style guide for document conventions. The rules below **are** the standard. Do not
open either source to apply them.

**Precedence.** ASD-STE100 governs sentence mechanics: word choice, sentence length, voice, tense,
and noun clusters. Google style governs document conventions: headings, lists, tables, links, code
font, punctuation, capitalization, and person. Common contractions are allowed.

## Scope

These rules govern all prose you author: chat replies, commit messages, PR bodies, issue comments,
`docs/**`, `docs/adr/**`, and prose inside code comments. See **Comments & Language** in the
`applying-engineering-standards` skill for the English-only rule and the why-not-what rule on comments.

Exemptions:

- Text you quote from a file, a tool result, or the user.
- Japanese UI strings, which **Comments & Language** in the `applying-engineering-standards` skill governs.
- The `Grammar:` line. It repeats the user's own sentence to correct it, and it judges grammar only.
  Never flag a correct sentence of the user for a style rule on this page.
- Code identifiers, which follow the rules for names in the project.
- Thinking blocks and scratch reasoning. Exploration needs room.
- Existing content. These rules govern prose you author from now on. Do not rewrite an existing file
  only to comply.

For Japanese prose, apply the intent only: short sentences, one instruction per step, plain words,
and a single negative. The English word tables below do not apply.

## No litotes

Never state a fact as the negation of its opposite. Say what is true.

| Do not write   | Write        |
| -------------- | ------------ |
| not uncommon   | frequent     |
| not unlike     | similar to   |
| no small task  | a large task |
| not wrong      | correct      |
| not impossible | possible     |
| not many       | few          |

One negative per sentence at most. Never use two.

## Sentence limits

Count the words. These are limits, not targets.

- A procedural sentence: 20 words maximum.
- A descriptive sentence: 25 words maximum.
- A noun cluster: 3 words maximum. Break a longer one with a preposition. Write "the timeout of the
  request handler", not "the request handler timeout value". A proper name is one term and is exempt.
- A paragraph of descriptive text: 6 sentences maximum.
- A procedural step: exactly one instruction. Split two actions into two steps.
- A bullet or a fragment: the descriptive cap of 25 words, counted across the fragment.

Also:

- Use the active voice. Use the passive voice only in descriptive text, and only when the actor is
  unknown or irrelevant.
- Use the simple tenses: past, present, future. Do not use a perfect or progressive tense. Write
  "the job runs", not "the job is running".
- Do not put an `-ing` word before a noun when a preposition reads clearer. Write "the rules for
  names", not "the naming rules". Three cases stay:
  - A plain adjective, such as `missing` or `existing`.
  - An established technical name, such as `logging` or `string`.
  - An `-ing` word after a preposition, or as a connective: `including`, `depending on`.
- Keep the article. Write "the file", not "file".
- Keep every word the grammar needs. Do not drop a word to shorten a sentence.
- One topic per sentence.

## Word choice

Use the plainest word that carries the meaning. One word keeps one meaning throughout a document.

| Do not use                  | Use                                      |
| --------------------------- | ---------------------------------------- |
| utilize, leverage           | use                                      |
| perform, execute (as prose) | do, run                                  |
| prior to                    | before                                   |
| subsequent to               | after                                    |
| additional                  | more                                     |
| sufficient                  | enough                                   |
| attempt                     | try                                      |
| terminate                   | stop, end                                |
| in order to                 | to                                       |
| e.g., i.e., etc., via       | for example, that is, and so on, through |
| may (for possibility)       | might, can                               |

Delete these words. They carry no information: `simply`, `just`, `easily`, `obviously`,
`of course`, `basically`, `actually`, `very`, `quite`, `really`.

Never use a slash to mean "and" or "or". Write the word.

## Document conventions

- Write in the second person. Address the reader as "you". Do not write "we".
- Use the present tense for behavior. Write "the API returns 404", not "the API will return 404".
- Write a heading in sentence case, and in the imperative for a task. Write "Set up the database",
  not "Setting Up The Database". This rule covers a document heading. A commit subject keeps the
  conventional-commit form of its repository, such as `docs(frontend): record the sidebar steps`.
- Use the serial comma: "backend, frontend, and infrastructure".
- Make the link text name its target. Never write "click here" or "this link".
- Put code, paths, commands, and identifiers in code font.
- Expand an abbreviation at its first use in a document.
- Spell out zero through nine. Use numerals from 10 up. Use numerals for a version, port, size, or
  measurement at any value.
- Do not write "please" in an instruction.
- Use inclusive terms: `allowlist` and `denylist`, `primary` and `replica`. Do not write `abort`,
  `kill`, or `hang` when a plain verb fits.

## Concise replies

A chat reply carries the answer, and stops. Every rule above still applies.

- Lead with the answer or the result. Write no preamble, and never restate the request.
- Say what changed, and what it costs the reader. Drop what the reader can already see.
- Use a table when three or more parallel facts appear. Prose hides a comparison.
- Do not close with a summary of your own body.
- Report a measurement as the number and the command. A story about the run is longer and says less.
- One heading only when the reply holds two topics the reader reads apart.

## Timeless prose

Prose states what is true, never when you learned it. The rule for a code comment is the same rule,
so **Comments & Language** points here rather than repeat it.

- No progress: "not applied yet", "the next phase", "still to do".
- No revision history: "previously", "an earlier round", "as I said above".
- No calendar: a date, "today", "this week". State the constraint, not the day it expires.
- Keep an issue ref that names a decision. Drop one that tracks progress.

One exemption: a document whose subject **is** time keeps its dates. That covers an ADR, a
`CHANGELOG.md`, a commit message, and a direct answer about what you did.
