// Branch: class values come from the theme tokens.

import { defaults } from "../../config.mjs";
import { classTokens } from "../jsx.mjs";
import { optionsOf, schemaOf } from "../options.mjs";

const ARBITRARY = /(?:^|:)!?-?[\w-]+-\[.+\](?:\/(?:\[[^\]]+\]|[\w.]+))?!?$|(?:^|:)!?\[[^\]]+\]!?$|\/\[[^\]]+\]!?$/;

export default {
  meta: {
    type: "suggestion",
    docs: { description: "Use theme tokens instead of arbitrary class values." },
    schema: schemaOf({ classCallees: { type: "array", items: { type: "string" } } }),
    messages: { arbitrary: "Class {{token}} uses an arbitrary value. Use a theme token." },
  },
  create(context) {
    const callees = optionsOf(context).classCallees ?? defaults.ui.classCallees;
    const sourceCode = context.sourceCode;
    return {
      "Program:exit"() {
        for (const token of classTokens(sourceCode, context.filename, callees)) {
          if (!ARBITRARY.test(token.text)) continue;
          context.report({
            loc: { start: sourceCode.getLocFromIndex(token.start), end: sourceCode.getLocFromIndex(token.end) },
            messageId: "arbitrary",
            data: { token: token.text },
          });
        }
      },
    };
  },
};
