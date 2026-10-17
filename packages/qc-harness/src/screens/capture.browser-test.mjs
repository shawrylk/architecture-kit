import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { capturePage } from "./capture.mjs";

test("capture includes a thumbnail whose response follows the ready selector", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "qc-screens-image-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext();
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
