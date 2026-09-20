import durableIdempotencyKey from "./rules/durable-idempotency-key.mjs";
import externalServiceOnlyInAdapter from "./rules/external-service-only-in-adapter.mjs";
import noCrossFeatureInternals from "./rules/no-cross-feature-internals.mjs";
import noCommentParagraph from "./rules/no-comment-paragraph.mjs";
import nameThePattern from "./rules/name-the-pattern.mjs";
import noPromiseThen from "./rules/no-promise-then.mjs";
import noNumberInComment from "./rules/no-number-in-comment.mjs";
import noOffsetPagination from "./rules/no-offset-pagination.mjs";
import noOrchestrationInTrigger from "./rules/no-orchestration-in-trigger.mjs";
import noRawFetch from "./rules/no-raw-fetch.mjs";
import noStatusLiteral from "./rules/no-status-literal.mjs";
import noSupersessionTrail from "./rules/no-supersession-trail.mjs";
import scopedRepository from "./rules/scoped-repository.mjs";
import signalLastParam from "./rules/signal-last-param.mjs";
import storageOnlyInResource from "./rules/storage-only-in-resource.mjs";
import tenantScopedTable from "./rules/tenant-scoped-table.mjs";

export const rules = {
  "durable-idempotency-key": durableIdempotencyKey,
  "external-service-only-in-adapter": externalServiceOnlyInAdapter,
  "no-cross-feature-internals": noCrossFeatureInternals,
  "no-comment-paragraph": noCommentParagraph,
  "name-the-pattern": nameThePattern,
  "no-promise-then": noPromiseThen,
  "no-number-in-comment": noNumberInComment,
  "no-offset-pagination": noOffsetPagination,
  "no-orchestration-in-trigger": noOrchestrationInTrigger,
  "no-raw-fetch": noRawFetch,
  "no-status-literal": noStatusLiteral,
  "no-supersession-trail": noSupersessionTrail,
  "scoped-repository": scopedRepository,
  "signal-last-param": signalLastParam,
  "storage-only-in-resource": storageOnlyInResource,
  "tenant-scoped-table": tenantScopedTable,
};

export default { rules };
