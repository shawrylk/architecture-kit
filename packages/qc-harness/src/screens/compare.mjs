import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** Pipeline: normalize dimensions and paint changed pixels over the right image. */
export function compareImages(left, right) {
  const width = Math.max(left.width, right.width);
  const height = Math.max(left.height, right.height);
  const padded = [left, right].map(source => {
    const image = new PNG({ width, height });
    PNG.bitblt(source, image, 0, 0, source.width, source.height, 0, 0);
    return image;
  });
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(padded[0].data, padded[1].data, diff.data, width, height, { threshold: 0.1, includeAA: true, diffMask: true, diffColor: [255, 0, 0] });
  const pair = new PNG({ width: width * 2, height });
  PNG.bitblt(padded[0], pair, 0, 0, width, height, 0, 0);
  PNG.bitblt(padded[1], pair, 0, 0, width, height, width, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (diff.data[offset + 3]) diff.data.copy(pair.data, (y * width * 2 + width + x) * 4, offset, offset + 4);
    }
  }
  return { pair, diffPixels, totalPixels: width * height, diffPercent: Number((100 * diffPixels / (width * height)).toFixed(4)) };
}

/** Ledger: list the greatest visual differences first. */
export function sortReport(rows) {
  return [...rows].sort((a, b) => b.diffPercent - a.diffPercent || a.screen.localeCompare(b.screen) || a.width - b.width);
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/** Fragment: a static gallery needs neither a server nor a script. */
export function gallery(rows) {
  const failed = rows.filter(row => row.error).map(row => `<p>${escapeHtml(row.screen)}: ${escapeHtml(row.error.message)}${row.error.screenshot ? ` <a href="${escapeHtml(row.error.screenshot)}">Failure screenshot</a>` : ""}</p>`).join("");
  if (failed) return gallery(rows.filter(row => !row.error)).replace("<h1>Screen pairs</h1>", `<h1>Screen pairs</h1>${failed}`);
  const crops = rows.flatMap(row => [...(row.inventoryFindings ?? []), ...(row.regions ?? [])].filter(region => region.crop).map(region => `<figure><figcaption>${escapeHtml(row.screen)} @ ${row.width}px — ${escapeHtml(region.kind)} ${region.id}</figcaption><a href="${escapeHtml(region.crop)}"><img loading="lazy" src="${escapeHtml(region.crop)}" alt="${escapeHtml(region.kind)} region ${region.id}"></a></figure>`)).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Screen pairs</title><style>body{font:16px system-ui;margin:24px;background:#fafafa;color:#222}img{max-width:100%;border:1px solid #ccc}figure{margin:24px 0}figcaption{margin:8px 0}</style><h1>Screen pairs</h1><p>Left: baseline. Right: comparison, with differences in red.</p>${crops}${rows.map(row => `<figure><figcaption>${escapeHtml(row.screen)} @ ${row.width}px: ${row.diffPercent}% (${escapeHtml(row.targets.join(" → "))})</figcaption><a href="${escapeHtml(row.pair)}"><img loading="lazy" src="${escapeHtml(row.pair)}" alt="${escapeHtml(row.screen)} pair at ${row.width} pixels"></a></figure>`).join("")}</html>`;
}
