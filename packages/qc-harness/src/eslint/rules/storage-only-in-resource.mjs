// One block touches storage. docs/architecture.md.
//
// The driver binding itself is the exception, and it has to be: something must
// import the driver for that block to have a pool to query through. It lives in
// the infrastructure path, which docs/architecture.md already permits to import
// anything. Recognising the path is what keeps this rule honest — matching
// filenames alone forced the one file that must import the driver to disable the
// rule, and a disable comment is how a rule stops meaning anything.

import { filenameOf, moduleGroup, optionsOf, schemaOf } from "../options.mjs";
import { isExemptFile } from "./module-boundary.mjs";

const DEFAULT_MODULES = ["drizzle-orm", "pg", "postgres"];
const DEFAULT_RESOURCE_FILES = ["resource.ts", "schema.ts"];
const DEFAULT_DRIVER_BINDING = "backend/src/infrastructure/db/";

export default {
  meta: {
    type: "problem",
    docs: { description: "storage imports belong in the resource block" },
    schema: schemaOf({
      modules: { type: "array", items: { type: "string" } },
      resourceFiles: { type: "array", items: { type: "string" } },
      driverBinding: { type: "string" },
    }),
    messages: { misplaced: "'{{source}}' belongs in {{allowed}} — the only block that touches storage." },
  },
  create(context) {
    const options = optionsOf(context);
    const storage = moduleGroup(options.modules ?? DEFAULT_MODULES);
    const resourceFiles = options.resourceFiles ?? DEFAULT_RESOURCE_FILES;
    const driverBinding = options.driverBinding ?? DEFAULT_DRIVER_BINDING;

    const exempt = isExemptFile(filenameOf(context), {
      allowedBasenames: resourceFiles,
      allowedPathPrefixes: driverBinding ? [driverBinding] : [],
    });
    return {
      ImportDeclaration(node) {
        if (exempt) return;
        const source = node.source.value;
        if (typeof source === "string" && storage.test(source)) {
          context.report({
            node,
            messageId: "misplaced",
            data: { source, allowed: resourceFiles.join(" or ") },
          });
        }
      },
    };
  },
};
