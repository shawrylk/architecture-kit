import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

function difference(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error("Capture dimensions differ");
  const mask = new PNG({ width: a.width, height: a.height });
  pixelmatch(a.data, b.data, mask.data, a.width, a.height, { threshold: 0.1, includeAA: true, diffMask: true });
  return mask;
}

/** Pipeline: accept two identical captures, or preserve the final unstable pixels after three retries. */
export async function stableCapture(capture) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const first = await capture();
    const image = await capture();
    const mask = difference(first, image);
    if (!mask.data.some((value, index) => index % 4 === 3 && value)) return { image, unstable: null };
    if (attempt === 3) return { image, unstable: mask };
  }
}

function components(mask, gap) {
  const cell = Math.max(1, gap);
  const columns = Math.ceil(mask.width / cell);
  const rows = Math.ceil(mask.height / cell);
  const occupied = new Uint8Array(columns * rows);
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    if (mask.data[(y * mask.width + x) * 4 + 3]) occupied[Math.floor(y / cell) * columns + Math.floor(x / cell)] = 1;
  }
  const boxes = [];
  for (let i = 0; i < occupied.length; i++) {
    if (!occupied[i]) continue;
    const queue = [i];
    occupied[i] = 0;
    let x0 = columns, y0 = rows, x1 = 0, y1 = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor], x = index % columns, y = Math.floor(index / columns);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, next = ny * columns + nx;
        if (nx >= 0 && nx < columns && ny >= 0 && ny < rows && occupied[next]) { occupied[next] = 0; queue.push(next); }
      }
    }
    let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1;
    for (let y = y0 * cell; y < Math.min(mask.height, (y1 + 1) * cell); y++) for (let x = x0 * cell; x < Math.min(mask.width, (x1 + 1) * cell); x++) {
      if (!mask.data[(y * mask.width + x) * 4 + 3]) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
  }
  return boxes;
}

const color = (image, x, y) => image.data.readUInt32LE((y * image.width + x) * 4);
function uniform(image, box) {
  const x0 = Math.max(0, box.x - 1), y0 = Math.max(0, box.y - 1);
  const first = color(image, x0, y0);
  for (let y = y0; y < Math.min(image.height, box.y + box.height + 1); y++) for (let x = x0; x < Math.min(image.width, box.x + box.width + 1); x++) if (color(image, x, y) !== first) return false;
  return true;
}

function shifted(a, b, box) {
  const x0 = Math.max(0, box.x - 2), y0 = Math.max(0, box.y - 2);
  const x1 = Math.min(a.width, box.x + box.width + 2), y1 = Math.min(a.height, box.y + box.height + 2);
  const matches = (dx, dy, stride) => {
    let compared = 0;
    for (let y = y0; y < y1; y += stride) for (let x = x0; x < x1; x += stride) {
      if (x + dx < 0 || x + dx >= b.width || y + dy < 0 || y + dy >= b.height) return false;
      if (color(a, x, y) !== color(b, x + dx, y + dy)) return false;
      compared++;
    }
    return compared > 0;
  };
  const stride = Math.max(1, Math.floor(Math.sqrt(box.width * box.height / 1000)));
  for (let distance = 1; distance <= 40; distance++) for (const [dx, dy] of [[0, distance], [0, -distance], [distance, 0], [-distance, 0]]) {
    if (matches(dx, dy, stride) && matches(dx, dy, 1)) return { dx, dy };
  }
  return null;
}

/** Pipeline: dilate differences on a grid, join components, and classify layout findings. */
export function findRegions(left, right, { unstable = [], gap = 6 } = {}) {
  const mask = difference(left, right);
  const instability = unstable.length === 2 && unstable[0]?.width ? difference(...unstable) : unstable.filter(Boolean)[0];
  const unstableBoxes = instability ? components(instability, gap) : [];
  if (instability) for (let i = 3; i < mask.data.length; i += 4) if (instability.data[i]) mask.data[i] = 0;
  const regions = components(mask, gap).map(box => {
    const shift = uniform(left, box) || uniform(right, box) ? null : shifted(left, right, box);
    return { box, kind: shift ? "shift" : uniform(right, box) && !uniform(left, box) ? "missing" : uniform(left, box) && !uniform(right, box) ? "extra" : "changed", ...(shift ? { shift } : {}) };
  });
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const a = regions[i], b = regions[j];
    if (a.kind !== "shift" || b.kind !== "shift" || a.shift.dx !== b.shift.dx || a.shift.dy !== b.shift.dy) continue;
    if (Math.max(a.box.x, b.box.x) - Math.min(a.box.x + a.box.width, b.box.x + b.box.width) > 40 || Math.max(a.box.y, b.box.y) - Math.min(a.box.y + a.box.height, b.box.y + b.box.height) > 40) continue;
    const x = Math.min(a.box.x, b.box.x), y = Math.min(a.box.y, b.box.y);
    a.box = { x, y, width: Math.max(a.box.x + a.box.width, b.box.x + b.box.width) - x, height: Math.max(a.box.y + a.box.height, b.box.y + b.box.height) - y };
    regions.splice(j--, 1);
  }
  regions.push(...unstableBoxes.map(box => ({ box, kind: "unstable" })));
  regions.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
  for (const [index, region] of regions.entries()) {
    region.id = index + 1;
    if (region.kind === "shift") region.causedBy = regions.find(other => other !== region && other.kind !== "unstable" && other.kind !== "shift" && other.box.y <= region.box.y)?.id ?? null;
  }
  return regions;
}

/** Fragment: show baseline, comparison, and pixel difference with padding and nearest-neighbor scaling. */
export function regionCrop(left, right, box, padding = 8) {
  const x = Math.max(0, box.x - padding), y = Math.max(0, box.y - padding);
  const width = Math.min(left.width, box.x + box.width + padding) - x;
  const height = Math.min(left.height, box.y + box.height + padding) - y;
  const diff = difference(left, right);
  const scale = Math.max(1, Math.ceil(600 / (width * 3)));
  const crop = new PNG({ width: width * 3 * scale, height: height * scale });
  [left, right, diff].forEach((source, panel) => {
    for (let cy = 0; cy < height * scale; cy++) for (let cx = 0; cx < width * scale; cx++) {
      const offset = ((y + Math.floor(cy / scale)) * source.width + x + Math.floor(cx / scale)) * 4;
      source.data.copy(crop.data, (cy * crop.width + panel * width * scale + cx) * 4, offset, offset + 4);
    }
  });
  return crop;
}

const digits = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"];
/** Fragment: draw numbered boxes on both halves of the pair. */
export function boxPair(pair, regions) {
  const half = pair.width / 2;
  const pixel = (x, y) => { if (x >= 0 && x < pair.width && y >= 0 && y < pair.height) pair.data.set([255, 0, 0, 255], (y * pair.width + x) * 4); };
  for (const region of regions) for (const offset of [0, half]) {
    const { x, y, width, height } = region.box;
    for (let dx = 0; dx < width; dx++) { pixel(x + offset + dx, y); pixel(x + offset + dx, y + height - 1); }
    for (let dy = 0; dy < height; dy++) { pixel(x + offset, y + dy); pixel(x + offset + width - 1, y + dy); }
    for (const [index, digit] of String(region.id).split("").entries()) for (let i = 0; i < 15; i++) if (digits[Number(digit)][i] === "1") for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) pixel(offset + x + index * 8 + i % 3 * 2 + sx, Math.max(0, y - 12) + Math.floor(i / 3) * 2 + sy);
  }
  return pair;
}
