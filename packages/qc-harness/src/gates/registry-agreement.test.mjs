import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkAgreement, declaredValues } from "./registry-agreement.mjs";

const SOURCE = `
export const PRESIGN_LIFETIME_SECONDS: Readonly<Record<PresignLifetime, number>> = {
  clientDefault: 600,
  downloadRedirect: 60,
};
`;
const key = (k) => "presign" + k.toLowerCase();

test("values are read out of the source constant", () => {
  assert.deepEqual(declaredValues(SOURCE, "PRESIGN_LIFETIME_SECONDS"), {
    clientDefault: 600,
    downloadRedirect: 60,
  });
});

test("agreement passes", () => {
  const registry = { presignclientdefault: { value: 600 }, presigndownloadredirect: { value: 60 } };
  assert.deepEqual(checkAgreement(declaredValues(SOURCE, "PRESIGN_LIFETIME_SECONDS"), registry, key, "port"), []);
});

test("a disagreement fails", () => {
  const registry = { presignclientdefault: { value: 900 }, presigndownloadredirect: { value: 60 } };
  const problems = checkAgreement(declaredValues(SOURCE, "PRESIGN_LIFETIME_SECONDS"), registry, key, "port");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "registry-disagreement");
});

test("a value with no registry entry fails", () => {
  const problems = checkAgreement({ ghost: 1 }, {}, key, "port");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "unregistered-value");
});
