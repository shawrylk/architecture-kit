// A third-party service is a concrete choice; only the adapter that implements the port, or
// the composition root that selects a provider, may import its SDK. The decision to scope a
// provider behind a port belongs to the repository that adopts this rule — cite its own ADR.
//
// Business logic that calls a cloud store, a payment gateway, or a message provider directly
// has no seam left for a second provider, and no seam for a test double either — the two
// reasons the port exists in the first place. The list below is a starting point, not a
// ceiling: a repository replaces `externalServices` with its own vendor list.

import { filenameOf, moduleGroup, optionsOf, schemaOf, scopeGroup } from "../options.mjs";
import { isExemptFile } from "./module-boundary.mjs";

const DEFAULT_SCOPES = ["@aws-sdk", "@azure", "@google-cloud", "@sendgrid", "@elastic", "@algolia", "@stripe", "@twilio"];
const DEFAULT_MODULES = ["aws-sdk", "stripe", "braintree", "twilio", "nodemailer", "algoliasearch", "amqplib", "kafkajs"];
const DEFAULT_ALLOWED_FILES = ["main.ts", "entry.ts"];
// Each entry names a category subfolder, not a bare "adapters/": a feature-local folder that
// happens to be named adapters/ must not become exempt by accident.
const DEFAULT_ALLOWED_PATHS = ["adapters/cloud/", "adapters/payments/", "adapters/messaging/", "adapters/search/"];

export default {
  meta: {
    type: "problem",
    docs: { description: "an external service's SDK belongs behind an adapter, or the composition root that selects a provider" },
    schema: schemaOf({
      scopes: { type: "array", items: { type: "string" } },
      modules: { type: "array", items: { type: "string" } },
      allowedFiles: { type: "array", items: { type: "string" } },
      allowedPaths: { type: "array", items: { type: "string" } },
    }),
    messages: {
      misplaced: "'{{source}}' belongs behind an adapter, or the composition root that selects a provider.",
    },
  },
  create(context) {
    const options = optionsOf(context);
    const scopes = scopeGroup(options.scopes ?? DEFAULT_SCOPES);
    const modules = moduleGroup(options.modules ?? DEFAULT_MODULES);
    const allowedFiles = options.allowedFiles ?? DEFAULT_ALLOWED_FILES;
    const allowedPaths = options.allowedPaths ?? DEFAULT_ALLOWED_PATHS;
    const exempt = isExemptFile(filenameOf(context), { allowedBasenames: allowedFiles, allowedPathPrefixes: allowedPaths });

    return {
      ImportDeclaration(node) {
        if (exempt) return;
        const source = node.source.value;
        if (typeof source === "string" && (scopes.test(source) || modules.test(source))) {
          context.report({ node, messageId: "misplaced", data: { source } });
        }
      },
    };
  },
};
