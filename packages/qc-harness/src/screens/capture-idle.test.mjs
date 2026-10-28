import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { capturePage } from "./capture.mjs";
import { chromeMissing } from "./chrome.mjs";

test("an entry with idle false captures a page that polls forever", { skip: await chromeMissing(chromium) }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-capture-idle-"));
  const server = http.createServer((req, res) => {
    if (req.url === "/poll") { res.writeHead(200); res.flushHeaders(); return; }
    res.setHeader("content-type", "text/html");
    res.end('<main id="ready" hidden>Pins</main><script>fetch("/poll").then(() => document.querySelector("#ready").hidden = false)</script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const target = { baseUrl: `http://127.0.0.1:${server.address().port}`, auth: { signedIn: "#ready" } };
  await assert.rejects(capturePage({ page }, target, { path: "/", ready: "#ready" }, 200, 200, path.join(root, "busy.png"), 1500), /networkidle|Timeout/);
  await capturePage({ page }, target, { path: "/", ready: "#ready", idle: false }, 200, 200, path.join(root, "polling.png"), 1500);
  assert.ok(existsSync(path.join(root, "polling.png")));
});
