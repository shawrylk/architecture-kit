import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { compareImages, sortReport } from "./compare.mjs";

test("diff counts pixels and marks the right image in red", () => {
  const left = new PNG({ width: 2, height: 1 });
  left.data.fill(255);
  const right = PNG.sync.read(PNG.sync.write(left));
  right.data[0] = 0;
  right.data[1] = 0;
  right.data[2] = 0;
  const result = compareImages(left, right);
  assert.equal(result.diffPercent, 50);
  assert.equal(result.diffPixels, 1);
  assert.equal(result.pair.width, 4);
  assert.deepEqual([...result.pair.data.subarray(8, 12)], [255, 0, 0, 255]);
});

test("report sorts greatest differences first with stable screen and width order", () => {
  assert.deepEqual(sortReport([{ screen: "b", width: 390, diffPercent: 0 }, { screen: "a", width: 390, diffPercent: 20 }, { screen: "a", width: 2514, diffPercent: 20 }]).map(r => `${r.screen}@${r.width}`), ["a@390", "a@2514", "b@390"]);
});

test("different dimensions count the extra area", () => {
  const left = new PNG({ width: 1, height: 1 });
  const right = new PNG({ width: 2, height: 1 });
  left.data.fill(255);
  right.data.fill(255);
  assert.equal(compareImages(left, right).diffPercent, 50);
});
