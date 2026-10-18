import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { findRegions, stableCapture, regionCrop } from "./regions.mjs";

function image(box) {
  const png = new PNG({ width: 120, height: 80 });
  png.data.fill(255);
  if (box) for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) png.data.set([20, 40, 80, 255], (y * png.width + x) * 4);
  return png;
}
test("unchanged layout finds zero regions", () => assert.deepEqual(findRegions(image(), image()), []));
test("a four pixel translation is one shift", () => {
  const regions = findRegions(image({ x: 20, y: 20, width: 40, height: 20 }), image({ x: 20, y: 24, width: 40, height: 20 }));
  assert.equal(regions.length, 1);
  assert.equal(regions[0].kind, "shift");
  assert.deepEqual(regions[0].shift, { dx: 0, dy: 4 });
});
test("removed and added controls receive directional kinds", () => {
  const box = image({ x: 20, y: 20, width: 40, height: 20 });
  assert.equal(findRegions(box, image())[0].kind, "missing");
  assert.equal(findRegions(image(), box)[0].kind, "extra");
});
test("unstable areas never become layout findings", () => {
  const a = image({ x: 20, y: 20, width: 40, height: 20 });
  assert.equal(findRegions(a, image(), { unstable: [a, image()] })[0].kind, "unstable");
});
test("double capture retries three times and retains the instability mask", async () => {
  let calls = 0;
  const result = await stableCapture(async () => ++calls % 2 ? image() : image({ x: 20, y: 20, width: 40, height: 20 }));
  assert.equal(calls, 8);
  assert.ok(result.unstable);
});
test("region crops contain three padded panels scaled to 600 pixels", () => {
  const crop = regionCrop(image(), image(), { x: 20, y: 20, width: 10, height: 10 });
  assert.ok(crop.width >= 600);
  assert.ok(crop.height > 0);
});
