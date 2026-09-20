import test from "node:test";
import assert from "node:assert/strict";
import { composeContract } from "./contract-compose.mjs";

const base = { openapi: "3.1.0", paths: {}, components: { securitySchemes: { bearerAuth: {} } } };

const alpha = {
  owner: "alpha",
  document: { paths: { "/v1/alpha": { get: {} } }, components: { schemas: { Alpha: {} } } },
};

test("every feature's paths and schemas reach the one root", () => {
  const composed = composeContract(base, [alpha]);
  assert.deepEqual(Object.keys(composed.paths), ["/v1/alpha"]);
  assert.deepEqual(Object.keys(composed.components.schemas), ["Alpha"]);
  assert.deepEqual(composed.components.securitySchemes, { bearerAuth: {} });
});

test("two features claiming one path fail, naming both", () => {
  const twin = { owner: "beta", document: alpha.document };
  assert.throws(() => composeContract(base, [alpha, twin]), /both 'alpha' and 'beta'/);
});

test("two features claiming one schema name fail", () => {
  const beta = { owner: "beta", document: { paths: { "/v1/beta": {} }, components: { schemas: { Alpha: {} } } } };
  assert.throws(() => composeContract(base, [alpha, beta]), /schema 'Alpha'/);
});

test("a feature that declares nothing contributes nothing", () => {
  const composed = composeContract(base, [{ owner: "empty", document: { paths: {} } }]);
  assert.deepEqual(composed.paths, {});
});

test("output order does not depend on feature order", () => {
  const beta = { owner: "beta", document: { paths: { "/v1/beta": {} }, components: { schemas: { Beta: {} } } } };
  const one = composeContract(base, [alpha, beta]);
  const two = composeContract(base, [beta, alpha]);
  assert.deepEqual(Object.keys(one.paths), Object.keys(two.paths));
  assert.deepEqual(Object.keys(one.components.schemas), Object.keys(two.components.schemas));
});
