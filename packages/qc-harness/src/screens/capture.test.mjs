import test from "node:test";
import assert from "node:assert/strict";
import { selectScreens, captureKey, mergeReport, safeClick } from "./capture.mjs";

test("only selects named screens and refuses unknown names", () => {
  const screens = [{ name: "projects" }, { name: "photos" }, { name: "drawings" }];
  assert.deepEqual(selectScreens(screens, "photos,drawings").map(s => s.name), ["photos", "drawings"]);
  assert.throws(() => selectScreens(screens, "typo"), /Unknown/);
});

test("cached captures change identity when routes or masks change", () => {
  const target = { baseUrl: "https://app.example" };
  const key = captureKey(target, { path: "/projects" }, 390, 900);
  assert.notEqual(captureKey(target, { path: "/photos" }, 390, 900), key);
  assert.notEqual(captureKey(target, { path: "/projects", masks: ["main"] }, 390, 900), key);
  assert.notEqual(captureKey(target, { path: "/projects" }, 390, 800), key);
});

test("filtered report replaces matching rows and preserves other screens", () => {
  const old = [{ screen: "photos", width: 390, targets: ["a", "b"], diffPercent: 50 }, { screen: "projects", width: 390, targets: ["a", "b"], diffPercent: 10 }];
  const fresh = [{ screen: "photos", width: 390, targets: ["a", "b"], diffPercent: 0 }];
  assert.deepEqual(mergeReport(old, fresh).map(r => [r.screen, r.diffPercent]), [["projects", 10], ["photos", 0]]);
});

test("hosted navigation rejects mutation controls", () => {
  for (const control of [{ type: "submit", text: "Continue" }, { type: "button", text: "Delete project" }, { type: "button", text: "Save" }, { type: "button", text: "Complete" }]) assert.equal(safeClick(control), false);
  assert.equal(safeClick({ type: "button", text: "Photos" }), true);
});
