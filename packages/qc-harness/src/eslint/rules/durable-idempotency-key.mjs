// An idempotency key is what makes a retry a resume. The client mints one per user
// operation and persists it, so a reload cannot lose it — docs/guards.md.
//
// Minting is therefore not the fault, and a rule that banned it would fire on every
// correct queue. What is checkable is a key minted *inline in a call argument*: a value
// built there is consumed by that call and cannot be re-sent, so the retry carries a
// different key and writes again. Bind it to a name, persist it, then send it.

import { optionsOf, schemaOf } from "../options.mjs";

const DEFAULT_KEYS = ["mutationId", "clientMutationId", "idempotencyKey"];
// A fresh value every call. Durable means: derived from the row, the request, or a
// value the client persisted before the first attempt.
const DEFAULT_VOLATILE = ["Date.now", "Math.random", "crypto.randomUUID", "uuid", "uuidv4", "nanoid", "randomUUID"];
// The key names the store a repeat would be recognised in, and the constructors that
// make one that outlives nothing.
const DEFAULT_LEDGER_KEY = "ledger";
const DEFAULT_THROWAWAY = ["InMemoryPipelineLedger"];

/** `crypto.randomUUID()` and `randomUUID()` are the same source, written two ways. */
function calleeName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && node.property.type === "Identifier") {
    const object = node.object.type === "Identifier" ? `${node.object.name}.` : "";
    return `${object}${node.property.name}`;
  }
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "an idempotency key comes from a durable id, never the clock or fresh randomness" },
    schema: schemaOf({
      keys: { type: "array", items: { type: "string" } },
      volatile: { type: "array", items: { type: "string" } },
      ledgerKey: { type: "string" },
      throwawayLedgers: { type: "array", items: { type: "string" } },
    }),
    messages: {
      volatile:
        "'{{key}}' is minted from {{source}} inside a call argument, so a retry cannot reuse it and writes again. Bind it to a name and persist it before sending.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const keys = new Set(options.keys ?? DEFAULT_KEYS);
    const volatile = new Set(options.volatile ?? DEFAULT_VOLATILE);
    const ledgerKey = options.ledgerKey ?? DEFAULT_LEDGER_KEY;
    const throwaway = new Set(options.throwawayLedgers ?? DEFAULT_THROWAWAY);

    /** The value assigned to a key, unwrapped through the shapes a default takes. */
    function sourceOf(node) {
      if (node === null || node === undefined) return null;
      if (node.type === "CallExpression" || node.type === "NewExpression") {
        const name = calleeName(node.callee);
        if (name === "Date") return "the clock";
        if (name !== null && volatile.has(name)) return name;
        // A volatile value formatted on the way out is still volatile:
        // `new Date().toISOString()` reads as a call to toISOString.
        if (node.callee.type === "MemberExpression") return sourceOf(node.callee.object);
        return null;
      }
      // `a ?? b`, `a || b`, `cond ? a : b` — a volatile fallback is still volatile.
      if (node.type === "LogicalExpression") return sourceOf(node.left) ?? sourceOf(node.right);
      if (node.type === "ConditionalExpression") return sourceOf(node.consequent) ?? sourceOf(node.alternate);
      return null;
    }

    /** True when this property is inside an object literal passed straight to a call. */
    function isCallArgument(node) {
      let child = node;
      let parent = node.parent;
      while (parent) {
        if (parent.type === "CallExpression" || parent.type === "NewExpression") {
          return parent.arguments.includes(child);
        }
        // A bound name, a return, or a stored property can all be persisted.
        if (
          parent.type === "VariableDeclarator" ||
          parent.type === "AssignmentExpression" ||
          parent.type === "ReturnStatement" ||
          parent.type === "ArrowFunctionExpression" ||
          parent.type === "FunctionDeclaration" ||
          parent.type === "FunctionExpression"
        ) {
          return false;
        }
        child = parent;
        parent = parent.parent;
      }
      return false;
    }

    /** A sibling naming a store that outlives nothing means nothing can be deduped. */
    function dedupeIsThrownAway(property) {
      const object = property.parent;
      if (!object || object.type !== "ObjectExpression") return false;
      return object.properties.some((sibling) => {
        if (sibling.type !== "Property") return false;
        if (sibling.key.type !== "Identifier" || sibling.key.name !== ledgerKey) return false;
        const built = sibling.value;
        if (built.type !== "NewExpression" && built.type !== "CallExpression") return false;
        const name = calleeName(built.callee);
        return name !== null && throwaway.has(name);
      });
    }

    return {
      Property(node) {
        if (node.key.type !== "Identifier" || !keys.has(node.key.name)) return;
        const source = sourceOf(node.value);
        if (source === null) return;
        if (!isCallArgument(node)) return;
        if (dedupeIsThrownAway(node)) return;
        context.report({ node, messageId: "volatile", data: { key: node.key.name, source } });
      },
    };
  },
};
