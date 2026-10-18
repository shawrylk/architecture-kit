import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCatalog, screen, navigationContext, applyCatalog } from "./catalog.mjs";

test("catalog loads TypeScript areas and rejects duplicate names", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-catalog-"));
  try {
    writeFileSync(path.join(root, "area.ts"), 'export const entry = {name:"photos/viewer",ready:{mono:"main"},open:{mono:async (page: any) => page.goto("/photos")}}');
    assert.equal((await loadCatalog(root))[0].name, "photos/viewer");
    writeFileSync(path.join(root, "other.ts"), 'export const entry = {name:"photos/viewer",open:{}}');
    await assert.rejects(loadCatalog(root), /Duplicate/);
    assert.throws(() => screen({ name: "../escape", open: {} }), /name/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed named step retains its name and screenshot", async () => {
  const calls = [];
  const page = { screenshot: async options => { calls.push(options.path); } };
  const ctx = navigationContext(page, { baseUrl: "http://localhost:3000", fixtures: { project: "p" } }, "target", "photos/viewer", ".");
  await assert.rejects(ctx.step("Open viewer", async () => { throw new Error("missing button"); }), error => error.step === "Open viewer" && error.screen === "photos/viewer" && error.target === "target" && Boolean(error.screenshot));
  assert.equal(ctx.fixtures.project, "p");
  assert.equal(calls.length, 1);
});

test("catalog entries carry the idle option for each app family", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-catalog-"));
  try {
    writeFileSync(path.join(root, "area.ts"), 'export const entry = {name:"drawings-pins",idle:{legacy:false},open:{legacy:async (page: any) => page.goto("/a"),mono:async (page: any) => page.goto("/b")}}');
    const map = await applyCatalog({ catalog: root, targets: { "legacy-local": { family: "legacy" }, "mono-local": { family: "mono" } }, screens: [] }, path.join(root, "map.json"));
    assert.equal(map.screens[0].targets["legacy-local"].idle, false);
    assert.equal(map.screens[0].targets["mono-local"].idle, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
