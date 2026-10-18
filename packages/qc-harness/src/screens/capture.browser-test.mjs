import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { capturePage } from "./capture.mjs";
import { findRegions } from "./regions.mjs";
import { collectInventory, diffInventory } from "./inventory.mjs";

test("accessibility inventory excludes table data and masked controls", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const content = value => `<label>Email<input placeholder="Your email"></label><button aria-label="Next">Go</button><table><tr><th>Title</th></tr><tr><td>${value}</td></tr></table><section id="masked"><button>Hidden</button></section>`;
    await page.setContent(content("First row"));
    const first = await collectInventory(page, ["#masked"]);
    await page.setContent(content("Other data"));
    const second = await collectInventory(page, ["#masked"]);
    assert.deepEqual(first.map(item => item.role), ["textbox", "button", "columnheader"]);
    assert.equal(first[0].name, "Email");
    assert.equal(first[0].placeholder, "Your email");
    assert.deepEqual(diffInventory(first, second), []);
  } finally { await browser.close(); }
});

test("different text in the same box produces identical layout images", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "qc-screens-layout-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1, serviceWorkers: "block" });
    let text = "First";
    await context.route("https://screens.example/**", route => route.fulfill({ contentType: "text/html", body: `<main id="ready"><button style="width:100px;height:40px">${text}</button></main>` }));
    const page = await context.newPage();
    const target = { baseUrl: "https://screens.example", auth: { signedIn: "#ready" } };
    await capturePage({ page }, target, { path: "/", ready: "#ready" }, 200, 100, path.join(directory, "a.png"), 5000);
    text = "Other text";
    await capturePage({ page }, target, { path: "/", ready: "#ready" }, 200, 100, path.join(directory, "b.png"), 5000);
    const images = ["a", "b"].map(name => PNG.sync.read(readFileSync(path.join(directory, `${name}.layout.png`))));
    assert.deepEqual(findRegions(...images), []);
  } finally {
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capture includes a thumbnail whose response follows the ready selector", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "qc-screens-image-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const image = new PNG({ width: 20, height: 20 });
    for (let offset = 0; offset < image.data.length; offset += 4) image.data.set([255, 0, 0, 255], offset);
    await context.route("https://screens.example/**", async route => {
      if (route.request().url().endsWith("/photo.png")) {
        await setTimeout(800);
        await route.fulfill({ contentType: "image/png", body: PNG.sync.write(image) });
      } else {
        await route.fulfill({ contentType: "text/html", body: '<body style="margin:0"><main id="ready"><img src="/photo.png" width="20" height="20"></main></body>' });
      }
    });
    const page = await context.newPage();
    const file = path.join(directory, "capture.png");
    await capturePage({ page }, { baseUrl: "https://screens.example", auth: { signedIn: "#ready" } }, { path: "/", ready: "#ready" }, 100, 100, file, 5000);
    const capture = PNG.sync.read(readFileSync(file));
    assert.deepEqual([...capture.data.subarray(0, 4)], [255, 0, 0, 255]);
  } finally {
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
