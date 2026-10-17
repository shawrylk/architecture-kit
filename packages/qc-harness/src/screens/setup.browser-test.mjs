import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { setupLocal, fixturePlan } from "./setup.mjs";

test("setup refuses cloud before launching a browser", async () => {
  await assert.rejects(setupLocal({ baseUrl: "https://cloud.example" }, "cloud", {}), /localhost/);
});

test("local UI setup makes real requests, resumes ids, and creates no duplicates", async () => {
  const records = new Map();
  let writes = 0;
  const server = http.createServer((request, response) => {
    const kind = new URL(request.url, "http://localhost").searchParams.get("kind");
    if (request.method === "POST") { records.set(kind, `id-${kind}`); writes++; response.writeHead(303, { location: `/?kind=${kind}` }).end(); return; }
    response.setHeader("content-type", "text/html");
    response.end(`<main>${records.has(kind) ? `<a data-testid="record" href="/records/${records.get(kind)}">QC-PARITY-TEST</a>` : '<form method="post"><label>Name<input name="name"></label><button>Create</button></form>'}</main>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-setup-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const target = { baseUrl: `http://127.0.0.1:${server.address().port}`, auth: { signedIn: "main" } };
  const adapter = Object.fromEntries(fixturePlan.map(item => [item.kind, {
    async find(page, ctx) {
      await page.goto(`${ctx.baseUrl}/?kind=${item.kind}`);
      return await page.getByTestId("record").count() ? (await page.getByTestId("record").getAttribute("href")).split("/").at(-1) : null;
    },
    async create(page, ctx) {
      await page.getByRole("textbox", { name: "Name" }).fill(ctx.item.name);
      await page.getByRole("button", { name: "Create" }).click();
      await page.getByTestId("record").waitFor();
      return (await page.getByTestId("record").getAttribute("href")).split("/").at(-1);
    },
  }]));
  const sessionFactory = async () => { const context = await browser.newContext(); return { context, page: await context.newPage(), close: () => context.close() }; };
  try {
    const options = { chromium, adapter, stateRoot: root, sessionFactory, timeout: 3000 };
    const first = await setupLocal(target, "fixture", options);
    assert.equal(Object.keys(first).length, fixturePlan.length);
    assert.equal(writes, fixturePlan.length);
    assert.deepEqual(await setupLocal(target, "fixture", options), first);
    assert.equal(writes, fixturePlan.length);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, "fixtures-fixture.json"))), first);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});
