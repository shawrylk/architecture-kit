import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { requireLocalhost } from "./map.mjs";
import { targetSession } from "./stack-auth.mjs";
import { privateRoot } from "./auth.mjs";
import { navigationContext } from "./catalog.mjs";

/** Record: both applications receive the same named test content. */
export const fixturePlan = [
  { kind: "project", name: "QC-PARITY-TEST" },
  { kind: "folder", name: "QC-PARITY-FOLDER" },
  { kind: "photo", name: "qc-parity-photo.png", asset: "photo" },
  { kind: "drawing", name: "qc-parity-drawing.pdf", asset: "drawing" },
  { kind: "document", name: "qc-parity-document.txt", asset: "document" },
  { kind: "blackboard", name: "QC-PARITY-BLACKBOARD" },
  { kind: "inspection", name: "QC-PARITY-INSPECTION" },
  { kind: "delivery", name: "QC-PARITY-DELIVERY" },
];

/** Resource: deterministic upload files need neither downloads nor app secrets. */
export function fixtureAssets(root) {
  mkdirSync(root, { recursive: true });
  const photo = new PNG({ width: 120, height: 80 });
  for (let y = 0; y < photo.height; y++) for (let x = 0; x < photo.width; x++) photo.data.set([x < 60 ? 32 : 200, 100, y < 40 ? 220 : 80, 255], (y * photo.width + x) * 4);
  const content = "BT /F1 20 Tf 36 150 Td (QC PARITY DRAWING) Tj ET\n";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}endstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const files = { photo: ["qc-parity-photo.png", PNG.sync.write(photo)], drawing: ["qc-parity-drawing.pdf", pdf], document: ["qc-parity-document.txt", "QC-PARITY-TEST\nDeterministic local fixture.\n"] };
  return Object.fromEntries(Object.entries(files).map(([kind, [name, bytes]]) => { const file = path.join(root, name); writeFileSync(file, bytes); return [kind, file]; }));
}

/** Pipeline: verify or create each resource through the app's UI and persist its id. */
export async function setupLocal(target, targetName, { chromium, adapter, stateRoot = privateRoot(), timeout = 15000, signInTimeout = 180000, say = console.error, sessionFactory = targetSession } = {}) {
  requireLocalhost(target.baseUrl);
  try { await fetch(target.baseUrl, { signal: AbortSignal.timeout(timeout), redirect: "manual" }); }
  catch { throw new Error(`Local target ${targetName} does not answer; start its stack first`); }
  if (!adapter) {
    if (!target.setup) throw new Error("Target requires a setup module with UI find and create functions");
    adapter = (await import(pathToFileURL(target.setup).href)).default;
  }
  for (const item of fixturePlan) if (typeof adapter[item.kind]?.find !== "function" || typeof adapter[item.kind]?.create !== "function") throw new Error(`Setup module requires ${item.kind}.find and create`);
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const file = path.join(stateRoot, `fixtures-${targetName}.json`);
  const fixtures = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const assets = fixtureAssets(path.join(stateRoot, "fixture-assets"));
  const session = await sessionFactory(chromium, target, { timeout, signInTimeout, allowWrites: true, say });
  try {
    const { page, context } = session;
    page.setDefaultTimeout(timeout);
    await context.route("**/*", async route => {
      try { requireLocalhost(route.request().url()); await route.fallback(); }
      catch { await route.abort("blockedbyclient"); }
    });
    const navigation = navigationContext(page, target, targetName, "setup", stateRoot);
    const ctx = { ...navigation, fixtures, assets };
    for (const item of fixturePlan) {
      ctx.item = item;
      let id = await ctx.step(`Find ${item.kind}`, () => adapter[item.kind].find(page, ctx));
      if (!id) {
        requireLocalhost(page.url());
        id = await ctx.step(`Create ${item.kind}`, () => adapter[item.kind].create(page, ctx));
      }
      requireLocalhost(page.url());
      if (typeof id !== "string" || !id) throw new Error(`Setup ${item.kind} returned no id`);
      fixtures[item.kind] = id;
      writeFileSync(`${file}.tmp`, `${JSON.stringify(fixtures, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      say(`Ready local fixture ${item.kind}`);
    }
    return fixtures;
  } finally { await session.close(); }
}
