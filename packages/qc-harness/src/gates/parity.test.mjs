import test from "node:test";
import assert from "node:assert/strict";
import { checkParity, placeholderSlices } from "./parity.mjs";

const roots = { server: "backend/src/features", client: "frontend/src/features", registry: "contracts/parity.json" };

function run({ server = [], client = [], registry = {} }) {
  return checkParity({ server, client, registry }, roots);
}

const rules = (problems) => problems.map((problem) => problem.rule);

test("two surfaces that carry the same features and slices pass", () => {
  const server = [{ name: "pins", slices: ["create-pin"], routes: ["create-pin"] }];
  const client = [{ name: "pins", slices: ["create-pin"] }];
  assert.deepEqual(run({ server, client }), []);
});

test("a feature on one surface only fails in both directions", () => {
  const problems = run({ server: [{ name: "billing", slices: [], routes: [] }], client: [{ name: "outbox", slices: [] }] });
  assert.deepEqual(rules(problems), ["one-sided-feature", "one-sided-feature"]);
  assert.equal(problems[0].path, "backend/src/features/billing");
  assert.equal(problems[1].path, "frontend/src/features/outbox");
});

test("a one-sided feature the registry names passes, and an entry both surfaces now have fails", () => {
  const registry = {
    backendOnlyFeatures: [{ name: "billing", why: "server only" }],
    frontendOnlyFeatures: [{ name: "pins", why: "stale" }],
  };
  const server = [{ name: "billing", slices: [], routes: [] }, { name: "pins", slices: [], routes: [] }];
  const problems = run({ server, client: [{ name: "pins", slices: [] }], registry });
  assert.deepEqual(rules(problems), ["stale-divergence"]);
  assert.equal(problems[0].path, "contracts/parity.json");
  assert.match(problems[0].detail, /pins: listed as one-sided/);
});

test("a slice or a route with no counterpart fails, in both directions", () => {
  const server = [{ name: "pins", slices: ["create-pin", "move-pin"], routes: ["create-pin", "drop-pin"] }];
  const client = [{ name: "pins", slices: ["create-pin", "draw-pin"] }];
  const details = run({ server, client }).map((problem) => problem.detail);
  assert.deepEqual(details.sort(), [
    "pins/draw-pin: a frontend slice with no backend slice/route of that name",
    "pins/drop-pin: backend route has no frontend slice",
    "pins/drop-pin: route in trigger.ts has no backend slice implementation",
    "pins/move-pin: a backend slice with no frontend slice of that name",
  ]);
});

test("a registry excuse covers a one-sided slice, and fails once it stops being true", () => {
  const server = [{ name: "pins", slices: ["render", "both"], routes: [] }];
  const client = [{ name: "pins", slices: ["both", "local"] }];
  const registry = {
    slices: {
      pins: [
        { stem: "render", why: "Backend-only: a worker route." },
        { stem: "local", why: "Client-only: a draft." },
        { stem: "both", why: "Backend-only: stale." },
        { stem: "gone", why: "Backend-only: deleted." },
      ],
    },
  };
  const details = run({ server, client, registry }).map((problem) => problem.detail);
  assert.deepEqual(details, [
    "pins/both: excused in contracts/parity.json, but both surfaces have it — delete the entry",
    "pins/gone: excused in contracts/parity.json, but neither surface has a slice of that name — delete the entry",
  ]);
});

test("an excuse whose reason names the wrong side fails", () => {
  const server = [{ name: "pins", slices: ["render"], routes: [] }];
  const client = [{ name: "pins", slices: [] }];
  const registry = { slices: { pins: [{ stem: "render", why: "Client-only: wrong side." }] } };
  const problems = run({ server, client, registry });
  assert.deepEqual(rules(problems), ["stale-divergence"]);
  assert.match(problems[0].detail, /excused as client-only/);
});

const slice = (contents, path = "frontend/src/features/tasks/slices/get-task.tsx") => [{ path, contents }];

test("a slice whose only export is a no-op fails as a placeholder, whatever its name", () => {
  const problems = placeholderSlices(slice("// placeholder for parity\nexport function PLACEHOLDER(): void { void 0; }"));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "placeholder-slice");
  assert.equal(problems[0].path, "frontend/src/features/tasks/slices/get-task.tsx");
});

test("an empty body, a bare return, and return undefined are no-ops too", () => {
  for (const body of ["", "return;", "return undefined;", "void 0"]) {
    assert.equal(placeholderSlices(slice(`export function stub() { ${body} }`)).length, 1, body);
  }
  assert.equal(placeholderSlices(slice("export const stub = () => {};")).length, 1);
  assert.equal(placeholderSlices(slice("export const stub = (): void => void 0;")).length, 1);
  assert.equal(placeholderSlices(slice("export async function stub(a: string): Promise<void> {\n  return;\n}")).length, 1);
});

test("a slice with one real export passes, even beside a no-op", () => {
  const real = "export function GetTask(props: Props) {\n  return <Task id={props.id} />;\n}";
  assert.deepEqual(placeholderSlices(slice(real)), []);
  assert.deepEqual(placeholderSlices(slice(`${real}\nexport function noop(): void { void 0; }`)), []);
  assert.deepEqual(placeholderSlices(slice("export const LIMIT = 20;\nexport function noop() {}")), []);
  assert.deepEqual(placeholderSlices(slice("export { getTask } from './get';\nexport function noop() {}")), []);
});

test("a file with no value export is not a placeholder, and a type export does not make one real", () => {
  assert.deepEqual(placeholderSlices(slice("const local = 1;\n")), []);
  assert.equal(placeholderSlices(slice("export type Row = { id: string };\nexport function noop() {}")).length, 1);
});
