import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { seedSession } from "./auth.mjs";

test("localhost form signs in automatically and saved state passes a real request", async () => {
  let submitted = false;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.method === "POST") {
      submitted = true;
      response.writeHead(302, { "set-cookie": "signed=yes; Path=/; HttpOnly", location: "/projects" }).end();
    } else if (request.url === "/projects") response.end(request.headers.cookie?.includes("signed=yes") ? '<main id="signed">Projects</main>' : "Expired");
    else response.end('<form method="post"><input id="user" name="user"><input id="pass" name="password" type="password"><button id="submit">Login</button></form>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const target = { baseUrl: `http://127.0.0.1:${server.address().port}`, auth: { mode: "form", path: "/login", signedIn: "#signed", userSelector: "#user", passwordSelector: "#pass", submitSelector: "#submit" } };
  try {
    const session = await seedSession(chromium, target, { credentials: { user: randomUUID(), password: randomUUID() } });
    await session.close();
    assert.equal(submitted, true);
    submitted = false;
    const saved = await seedSession(chromium, target, { savedOnly: true, timeout: 3000 });
    await saved.close();
    assert.equal(submitted, false);
    await assert.rejects(seedSession(chromium, { ...target, baseUrl: "https://cloud.example" }), /localhost/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
