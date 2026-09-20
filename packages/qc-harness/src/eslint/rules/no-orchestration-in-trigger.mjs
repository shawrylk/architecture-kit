// A UI trigger is a thin presenter. Multi-step orchestration belongs in a headless
// pipeline. docs/architecture.md.

import { filenameOf, optionsOf, pathGlob, schemaOf, TEST_FILE } from "../options.mjs";

const DEFAULT_PRESENTERS = "frontend/src/features/*/trigger";
const DEFAULT_MAX_AWAITS = 1;

export default {
  meta: {
    type: "problem",
    docs: { description: "UI triggers cannot orchestrate multi-step asynchronous business flows" },
    schema: schemaOf({ presenters: { type: "string" }, maxAwaits: { type: "integer", minimum: 1 } }),
    messages: {
      orchestration:
        "Multi-step orchestration in a UI trigger. Encapsulate the workflow as a headless saga or pipeline command.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const filename = filenameOf(context);
    if (!pathGlob(options.presenters ?? DEFAULT_PRESENTERS).test(filename)) return {};
    if (TEST_FILE.test(filename)) return {};

    const maxAwaits = options.maxAwaits ?? DEFAULT_MAX_AWAITS;
    const functionStack = [];

    function enterFunction(node) {
      functionStack.push({ node, awaitNodes: [] });
    }

    function exitFunction() {
      const current = functionStack.pop();
      if (!current) return;
      if (current.awaitNodes.length > maxAwaits) {
        for (const node of current.awaitNodes.slice(maxAwaits)) {
          context.report({ node, messageId: "orchestration" });
        }
      }
    }

    return {
      FunctionDeclaration: enterFunction,
      FunctionExpression: enterFunction,
      ArrowFunctionExpression: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      "FunctionExpression:exit": exitFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      AwaitExpression(node) {
        if (functionStack.length > 0) {
          functionStack[functionStack.length - 1].awaitNodes.push(node);
        }
      },
    };
  },
};
