import test from "node:test";
import assert from "node:assert/strict";
import { contractOperations } from "./contract-operations.mjs";

const contract = `
openapi: 3.0.3
paths:
  /v1/projects:
    post:
      operationId: createProject
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CreateProject"
    get:
      operationId: listProjects
      parameters:
        - $ref: "#/components/parameters/Cursor"
  /v1/projects/{id}:
    parameters:
      - name: id
        in: path
    delete:
      operationId: deleteProject
    put:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name: { type: string }
components:
  parameters:
    Cursor:
      name: cursor
      in: query
  schemas:
    CreateProject:
      type: object
      properties:
        name: { type: string }
        mutationId: { type: string }
`;

test("methods and paths are read", async () => {
  const found = await contractOperations(contract);
  assert.deepEqual(
    found.map(({ method, path }) => `${method} ${path}`),
    ["post /v1/projects", "get /v1/projects", "delete /v1/projects/{id}", "put /v1/projects/{id}"],
  );
});

test("an operation id is read, and an operation without one is named by its method and path", async () => {
  const found = await contractOperations(contract);
  assert.deepEqual(
    found.map(({ id }) => id),
    ["createProject", "listProjects", "deleteProject", "PUT /v1/projects/{id}"],
  );
});

test("a $ref body resolves to its properties", async () => {
  const [create] = await contractOperations(contract);
  assert.deepEqual(create.bodyProps, ["name", "mutationId"]);
});

test("an inline body and an allOf body list their properties", async () => {
  const found = await contractOperations(`
paths:
  /a:
    post:
      requestBody:
        content:
          application/json:
            schema:
              allOf:
                - $ref: "#/components/schemas/Base"
                - properties: { extra: {} }
components:
  schemas:
    Base:
      properties: { mutationId: {} }
`);
  assert.deepEqual(found[0].bodyProps, ["mutationId", "extra"]);
  const inline = await contractOperations(contract);
  assert.deepEqual(inline[3].bodyProps, ["name"]);
});

test("parameters come from the operation, the path item and a $ref", async () => {
  const found = await contractOperations(contract);
  assert.deepEqual(found[1].params, ["cursor"]);
  assert.deepEqual(found[2].params, ["id"]);
  assert.deepEqual(found[0].params, []);
});

test("a key under a path that is not a method is ignored", async () => {
  const found = await contractOperations("paths:\n  /a:\n    summary: x\n    get: {}\n");
  assert.deepEqual(found.map(({ method }) => method), ["get"]);
});

test("a document with no paths holds no operations", async () => {
  assert.deepEqual(await contractOperations("openapi: 3.0.3\n"), []);
  assert.deepEqual(await contractOperations(""), []);
});

test("a missing yaml peer fails with a message that names it", async () => {
  const absent = () => Promise.reject(Object.assign(new Error("Cannot find package 'yaml'"), { code: "ERR_MODULE_NOT_FOUND" }));
  await assert.rejects(
    contractOperations(contract, { load: absent }),
    (error) => error.code === "CONTRACT_PEER_MISSING" && /`yaml`/.test(error.message),
  );
});
