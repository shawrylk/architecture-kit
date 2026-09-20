import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkFrontendBoundaries } from "./frontend-boundaries.mjs";

test("a clean platform directory with cohesive files passes", () => {
  const platformFiles = [
    { path: "platform/auth/use-session.ts" },
    { path: "platform/auth/auth-gate.tsx" },
    { path: "platform/preferences/hand-preference.tsx" },
  ];
  const problems = checkFrontendBoundaries(platformFiles, []);
  assert.deepEqual(problems, []);
});

test("a domain leak in platform is detected and flagged", () => {
  const platformFiles = [
    { path: "platform/shell/drawing-viewer/drawing-viewer-modal.tsx" },
    { path: "platform/shell/drawing-viewer/drawing-viewer-canvas.tsx" },
    { path: "platform/shell/inspections/inspection-checklist-panel.tsx" },
    { path: "platform/shell/chrome/photo-viewer.tsx" },
  ];
  const problems = checkFrontendBoundaries(platformFiles, []);
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => p.path === "platform/shell/drawing-viewer" && p.rule === "domain-in-platform"));
  assert.ok(problems.some((p) => p.path === "platform/shell/inspections" && p.rule === "domain-in-platform"));
  assert.ok(problems.some((p) => p.path === "platform/shell/chrome/photo-viewer.tsx" && p.rule === "domain-in-platform"));
});

test("a junk drawer folder mixing multiple domains is detected", () => {
  const platformFiles = [
    { path: "platform/shell/chrome/account-menu.tsx" },
    { path: "platform/shell/chrome/ai-quota-badge.tsx" },
    { path: "platform/shell/chrome/app-header.tsx" },
    { path: "platform/shell/chrome/app-layout.tsx" },
    { path: "platform/shell/chrome/auth-gate.tsx" },
    { path: "platform/shell/chrome/hand-preference.tsx" },
    { path: "platform/shell/chrome/language-menu.tsx" },
    { path: "platform/shell/chrome/layout-preference.tsx" },
    { path: "platform/shell/chrome/personal-settings-modal.tsx" },
    { path: "platform/shell/chrome/theme-toggle.tsx" },
    { path: "platform/shell/chrome/use-session.ts" },
    { path: "platform/shell/chrome/view-mode-preference.ts" },
  ];
  const problems = checkFrontendBoundaries(platformFiles, []);
  const junkDrawer = problems.find((p) => p.rule === "junk-drawer-folder");
  assert.ok(junkDrawer);
  assert.equal(junkDrawer.path, "platform/shell/chrome");
  assert.ok(junkDrawer.detail.includes("Suggestion:"));
});

test("a backslash path fails loud instead of bucketing every file as one folder", () => {
  const platformFiles = [{ path: "platform\\shell\\chrome\\app-header.tsx" }];
  assert.throws(() => checkFrontendBoundaries(platformFiles, []), /backslash/);
});

test("an absolute, OS-native featureFiles path is not the same bug and does not throw", () => {
  const featureFiles = [{ path: "C:\\repo\\backend\\src\\features\\orders\\index.ts", contents: "" }];
  assert.doesNotThrow(() => checkFrontendBoundaries([], featureFiles));
});

test("an inverted feature import is detected", () => {
  const featureFiles = [
    {
      path: "features/photos/slices/view-photo-run.tsx",
      contents: 'import { PhotoViewerModalDialog } from "../../../platform/shell/chrome/photo-viewer.js";',
    },
  ];
  const problems = checkFrontendBoundaries([], featureFiles);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, "inverted-feature-import");
  assert.ok(problems[0].detail.includes("Suggestion:"));
});
