import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { discover } from "./discovery.mjs";

test("one SPA URL exposes five states; writes and an automatic POST stay blocked", async () => {
  let writes = 0;
  const server = http.createServer((request, response) => {
    if (request.method === "POST") writes++;
    response.setHeader("content-type", "text/html");
    response.end(`<main><h1>Workspace</h1><button role="tab" aria-selected="false" onclick="this.setAttribute('aria-selected','true')">Photos</button><button role="tab" aria-selected="false" onclick="this.setAttribute('aria-selected','true')">Drawings</button><button onclick="document.querySelector('dialog').showModal()">Open dialog</button><button onclick="document.querySelector('[role=menu]').hidden=false">Open menu</button><button onclick="fetch('/write',{method:'POST'})">Save</button><dialog aria-label="Details">Details</dialog><div role="menu" aria-label="Actions" hidden>Actions</div></main><script>fetch('/automatic',{method:'POST'})</script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const out = mkdtempSync(path.join(os.tmpdir(), "qc-discover-"));
  try {
    const result = await discover({ context, page: await context.newPage() }, { baseUrl: `http://127.0.0.1:${server.address().port}`, routes: ["/"], auth: { signedIn: "main" } }, { out, targetName: "fixture", widths: [390], depth: 1, timeout: 3000 });
    assert.equal(result.states.length, 5);
    assert.equal(result.errors.length, 0);
    assert.equal(result.states.some(state => state.path.some(step => step.name === "Save")), false);
    assert.equal(writes, 0);
    assert.ok(result.blockedRequests > 0);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(out, { recursive: true, force: true }); }
});
