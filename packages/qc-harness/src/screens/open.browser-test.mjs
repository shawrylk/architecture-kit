import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { runScreens } from "../cli/screens.mjs";

for (const mode of ["form", "seed-login"]) for (const allowWrites of [false, true]) {
  test(`open ${mode} ${allowWrites ? "permits" : "blocks"} localhost POST`, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qc-open-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(os, "homedir", () => root);
    let posts = 0;
    const server = http.createServer((request, response) => {
      if (request.method === "POST") { posts++; response.end("ok"); return; }
      response.setHeader("content-type", "text/html");
      response.end('<main>Screen</main><script>fetch("/write", { method: "POST" }).then(() => window.result = "sent", () => window.result = "blocked")</script>');
    });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const auth = { mode, signedIn: "main", userSelector: "#user", passwordSelector: "#secret", submitSelector: "button", seedFile: "unused.json", userField: "user", passwordField: "secret" };
    const target = { baseUrl, auth };
    const mapFile = path.join(root, "map.json");
    writeFileSync(mapFile, JSON.stringify({ widths: [390], targets: { local: target, other: target }, screens: [{ name: "screen", targets: { local: { path: "/screen" }, other: { path: "/screen" } } }] }));
    const browser = await chromium.launch({ channel: "chrome" });
    t.after(() => browser.close());
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    let passedOptions;
    const messages = [];
    const running = runScreens(["open", "screen", "--map", mapFile, "--target", "local", ...(allowWrites ? ["--allow-writes"] : [])], {
      say: message => messages.push(message),
      sessionFactory: async (_chromium, _target, options) => {
        passedOptions = options;
        return { context, page, close: () => context.close() };
      },
    });
    await page.waitForURL(`${baseUrl}/screen`, { timeout: 5000 });
    await page.waitForFunction(() => window.result, { timeout: 5000 });
    const result = await page.evaluate(() => window.result);
    await page.close();
    assert.equal(await running, 0, messages.join("\n"));
    assert.equal(result, allowWrites ? "sent" : "blocked");
    assert.equal(posts, allowWrites ? 1 : 0);
    assert.equal(passedOptions.allowWrites, allowWrites);
  });
}
