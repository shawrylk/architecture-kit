import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import { captureScreens } from "./capture.mjs";

test("a failing catalog step records its screenshot while the other screen completes", async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "qc-catalog-browser-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const target = { baseUrl: "https://screens.example", auth: { signedIn: "main" } };
  const route = fail => ({ path: fail ? "/bad" : "/good", ready: "main", open: async (page, ctx) => {
    await ctx.step("Navigate", () => page.goto(`${ctx.baseUrl}/${fail ? "bad" : "good"}`));
    if (fail) await ctx.step("Open viewer", () => page.getByRole("button", { name: "Missing", exact: true }).click({ timeout: 100 }));
  } });
  try {
    const report = await captureScreens({ widths: [200], targets: { a: target, b: target }, screens: ["bad", "good"].map(name => ({ name, targets: { a: route(name === "bad"), b: route(name === "bad") } })) }, { targets: ["a", "b"], out, timeout: 3000, height: 100 }, {
      chromium, say: () => {}, sessionFactory: async () => {
        const context = await browser.newContext({ serviceWorkers: "block" });
        const page = await context.newPage();
        await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<main><h1>Fixture</h1><a href="/good">Good page</a></main>' }));
        return { context, page, close: () => context.close() };
      },
    });
    const bad = report.find(row => row.screen === "bad");
    assert.equal(bad.error.step, "Open viewer");
    assert.equal(existsSync(path.join(out, bad.error.screenshot)), true);
    assert.equal(report.find(row => row.screen === "good").diffPercent, 0);
    assert.equal(existsSync(path.join(out, "good/pair@200.png")), true);
  } finally { await browser.close(); rmSync(out, { recursive: true, force: true }); }
});
