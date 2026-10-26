// Branch: primitive folders own raw form controls and dialogs.

import { tagName } from "../jsx.mjs";
import { filenameOf, optionsOf, pathPrefix, schemaOf } from "../options.mjs";

const ELEMENTS = ["form", "dialog", "input", "select", "textarea", "button"];
const PRIMITIVE = "frontend/src/platform/ui/primitives";

export default {
  meta: {
    type: "suggestion",
    docs: { description: "Use raw form elements only in primitive folders." },
    schema: schemaOf({
      elements: { type: "array", items: { type: "string" } },
      primitive: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    }),
    messages: { raw: "Raw <{{element}}> belongs in a primitive folder. Use a primitive component here." },
  },
  create(context) {
    const options = optionsOf(context);
    const folders = [options.primitive ?? PRIMITIVE].flat().map((folder) => pathPrefix(folder.replaceAll("\\", "/")));
    if (folders.some((folder) => folder.test(filenameOf(context)))) return {};
    const elements = new Set(options.elements ?? ELEMENTS);
    return {
      JSXOpeningElement(node) {
        const element = tagName(node.name);
        if (elements.has(element)) context.report({ node, messageId: "raw", data: { element } });
      },
    };
  },
};
