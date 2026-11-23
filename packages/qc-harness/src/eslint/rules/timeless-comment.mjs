// A comment states what is true, never when it became true. A reader meets it long after the
// change that prompted it, so a promise or a date inside it is a fact that has already rotted.
// git holds the history, an issue holds the promise, and a decision record holds the decision.
//
// Comments only. The same word inside a string is someone's data, not this repository dating itself.
// no-supersession-trail owns the past tense. This rule owns the promise and the moment.

import { escape, optionsOf, schemaOf } from "../options.mjs";

// Work a comment says is still owed. The comment outlives the intent every time.
const DEFAULT_PROMISES = [
  "todo",
  "fixme",
  "for now",
  "temporarily",
  "temporary fix",
  "temporary workaround",
  "temporary until",
  "not yet implemented",
  "not implemented yet",
  "coming soon",
  "in a future",
  "in future",
  "revisit",
  "stopgap",
  "will be replaced",
  "will be removed",
  "will be renamed",
];

// Wording that pins the comment to the day someone wrote it. A phrase a repository reads as
// ordinary prose belongs in its own config, not here: a rule nobody can satisfy gets switched off.
const DEFAULT_MOMENTS = [
  "currently",
  "at the moment",
  "at present",
  "right now",
  "as of",
  "recently",
  "nowadays",
  "these days",
  "newly added",
  "just added",
  "previously",
  "originally",
  "for the time being",
  "since the refactor",
  "after the refactor",
  "renamed from",
  "we now",
];

/** An empty list matches nothing, so a repository can switch off one half and keep the other. */
function group(phrases) {
  if (phrases.length === 0) return /(?!)/;
  return new RegExp(`\\b(${phrases.map(escape).join("|")})\\b`, "i");
}

export default {
  meta: {
    type: "problem",
    docs: { description: "a comment states what is true, never when it became true or what is still owed" },
    schema: schemaOf({
      promises: { type: "array", items: { type: "string" } },
      moments: { type: "array", items: { type: "string" } },
    }),
    messages: {
      promise: "'{{phrase}}' owes future work. A comment states what is true. Put the promise in an issue or a decision record.",
      moment: "'{{phrase}}' dates this comment. State what is true, not when it became true.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const groups = [
      { id: "promise", pattern: group(options.promises ?? DEFAULT_PROMISES) },
      { id: "moment", pattern: group(options.moments ?? DEFAULT_MOMENTS) },
    ];
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          for (const { id, pattern } of groups) {
            const found = pattern.exec(comment.value);
            if (found === null) continue;
            // One finding per comment: a reader fixes the sentence, not each word in it.
            context.report({ node: comment, messageId: id, data: { phrase: found[1].toLowerCase() } });
            break;
          }
        }
      },
    };
  },
};
