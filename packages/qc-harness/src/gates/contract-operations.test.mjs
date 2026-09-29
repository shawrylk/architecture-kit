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

test("a schema that composes itself ends the walk rather than the process", async () => {
  const found = await contractOperations(`
paths:
  /a:
    post:
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Loop"
components:
  schemas:
    Loop:
      properties: { name: {} }
      allOf:
        - $ref: "#/components/schemas/Loop"
`);
  assert.deepEqual(found[0].bodyProps, ["name"]);
});

const NL = String.fromCharCode(10);

const slow = (run) => async () => {
  const started = performance.now();
  await run();
  assert.ok(performance.now() - started < 1000, "the walk took one second or more");
};

const post = (schema) => `
paths:
  /a:
    post:
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/${schema}"
components:
  schemas:
`;

test("a wide self-referencing allOf finishes at once", slow(async () => {
  const refs = Array.from({ length: 14 }, () => '        - $ref: "#/components/schemas/Loop"').join(NL);
  const found = await contractOperations([post("Loop"), "    Loop:", "      properties: { name: {} }", "      allOf:", refs, ""].join(NL));
  assert.deepEqual(found[0].bodyProps, ["name"]);
}));

test("two schemas that compose each other finish at once and keep both property sets", slow(async () => {
  const found = await contractOperations(`${post("Ping")}
    Ping:
      properties: { a: {} }
      allOf: [{ $ref: "#/components/schemas/Pong" }, { $ref: "#/components/schemas/Pong" }]
    Pong:
      properties: { b: {} }
      allOf: [{ $ref: "#/components/schemas/Ping" }, { $ref: "#/components/schemas/Ping" }]
`);
  assert.deepEqual(found[0].bodyProps.sort(), ["a", "b"]);
}));

test("a schema reached by two routes is walked once and still counted", async () => {
  const found = await contractOperations(`${post("Top")}
    Top:
      allOf: [{ $ref: "#/components/schemas/Left" }, { $ref: "#/components/schemas/Right" }]
    Left:
      allOf: [{ $ref: "#/components/schemas/Base" }]
    Right:
      allOf: [{ $ref: "#/components/schemas/Base" }]
      properties: { r: {} }
    Base:
      properties: { mutationId: {} }
`);
  assert.deepEqual(found[0].bodyProps, ["mutationId", "r"]);
});

test("a $ref segment is percent-decoded, and ~0 and ~1 are unescaped", async () => {
  const found = await contractOperations(`${post("Create%20Board")}
    Create Board:
      allOf: [{ $ref: "#/components/schemas/a~1b" }, { $ref: "#/components/schemas/c~0d" }]
    a/b:
      properties: { slash: {} }
    c~d:
      properties: { tilde: {} }
`);
  assert.deepEqual(found[0].bodyProps, ["slash", "tilde"]);
});

test("a schema first reached past the depth cap still counts when a shallow path reaches it", async () => {
  const found = await contractOperations(`${post("Top")}
    Top:
      allOf: [{ $ref: "#/components/schemas/C1" }, { $ref: "#/components/schemas/X" }]
    C1:
      allOf: [{ $ref: "#/components/schemas/C2" }]
    C2:
      allOf: [{ $ref: "#/components/schemas/C3" }]
    C3:
      allOf: [{ $ref: "#/components/schemas/C4" }]
    C4:
      allOf: [{ $ref: "#/components/schemas/C5" }]
    C5:
      allOf: [{ $ref: "#/components/schemas/X" }]
    X:
      properties: { mutationId: {} }
`);
  assert.deepEqual(found[0].bodyProps, ["mutationId"]);
});

test("a ref keeps its shallowest reach: one first met near the cap is walked again from a shallower path", async () => {
  const found = await contractOperations(`${post("Top")}
    Top:
      allOf: [{ $ref: "#/components/schemas/C1" }, { $ref: "#/components/schemas/A" }]
    C1:
      allOf: [{ $ref: "#/components/schemas/C2" }]
    C2:
      allOf: [{ $ref: "#/components/schemas/C3" }]
    C3:
      allOf: [{ $ref: "#/components/schemas/C4" }]
    C4:
      allOf: [{ $ref: "#/components/schemas/A" }]
    A:
      allOf: [{ $ref: "#/components/schemas/B" }]
    B:
      properties: { mutationId: {} }
`);
  assert.deepEqual(found[0].bodyProps, ["mutationId"]);
});
