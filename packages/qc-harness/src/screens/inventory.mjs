const normalize = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const key = item => `${item.role}:${normalize(item.name)}`;
const roles = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "spinbutton", "slider", "switch", "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "heading", "columnheader"]);

/** Pipeline: read accessible names from Playwright snapshots and attach field metadata in page order. */
export async function collectInventory(page, excludes = []) {
  const selector = 'input,textarea,select,button,a[href],h1,h2,h3,h4,h5,h6,th,[role]';
  const elements = page.locator(selector);
  const inventory = [];
  for (let index = 0; index < await elements.count(); index++) {
    const element = elements.nth(index);
    const metadata = await element.evaluate((node, omitted) => {
      if (omitted.some(selector => node.closest(selector))) return null;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none") return null;
      const type = node.tagName === "SELECT" ? "select" : node.getAttribute("type") ?? (node.tagName === "TEXTAREA" ? "textarea" : "");
      if (type === "hidden") return null;
      return { type, label: Array.from(node.labels ?? []).map(label => label.textContent.trim()).join(" "), placeholder: node.getAttribute("placeholder") ?? "", state: { disabled: node.matches(":disabled") || node.getAttribute("aria-disabled") === "true", required: node.required === true || node.getAttribute("aria-required") === "true", checked: "checked" in node ? node.checked : node.getAttribute("aria-checked"), selected: node.getAttribute("aria-selected"), value: node.tagName === "SELECT" ? node.selectedOptions[0]?.textContent?.trim() ?? "" : undefined }, box: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height } };
    }, excludes);
    if (!metadata) continue;
    const snapshot = await element.ariaSnapshot();
    const match = snapshot.match(/^- (\w+)(?: "((?:\\.|[^"\\])*)")?/);
    if (!match || !roles.has(match[1])) continue;
    let name = match[2] ?? "";
    try { name = JSON.parse(`"${name}"`); } catch { /* Names from older Playwright snapshots can contain literal newlines. */ }
    inventory.push({ role: match[1], name, ...metadata });
  }
  return inventory;
}

/** Pipeline: align role and normalized name, then reconcile moves, renames, types, and states. */
export function diffInventory(left, right) {
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) rows[i][j] = key(left[i]) === key(right[j]) ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const aligned = [], unmatchedLeft = [], unmatchedRight = [];
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && key(left[i]) === key(right[j])) aligned.push([i++, j++]);
    else if (i < left.length && (j === right.length || rows[i + 1][j] >= rows[i][j + 1])) unmatchedLeft.push(i++);
    else unmatchedRight.push(j++);
  }
  const findings = [];
  const add = (kind, a, b) => findings.push({ id: findings.length + 1, kind, left: a === undefined ? null : left[a], right: b === undefined ? null : right[b], leftIndex: a ?? null, rightIndex: b ?? null });
  for (const [a, b] of aligned) {
    if (left[a].type !== right[b].type) add("type", a, b);
    if (JSON.stringify(left[a].state) !== JSON.stringify(right[b].state)) add("state", a, b);
  }
  const used = new Set();
  for (const a of unmatchedLeft) {
    let b = unmatchedRight.find(b => !used.has(b) && key(left[a]) === key(right[b]));
    if (b !== undefined) { used.add(b); add("moved", a, b); continue; }
    b = unmatchedRight.find(b => !used.has(b) && normalize(left[a].name) === normalize(right[b].name));
    if (b !== undefined) { used.add(b); add("type", a, b); continue; }
    b = unmatchedRight.find(b => !used.has(b) && left[a].role === right[b].role && Math.abs(a - b) <= 1);
    if (b !== undefined) { used.add(b); add("renamed", a, b); continue; }
    add("missing", a, undefined);
  }
  for (const b of unmatchedRight) if (!used.has(b)) add("extra", undefined, b);
  return findings;
}

/** Record: cover the visible part of either element with one crop. */
export function inventoryBox(finding, width, height) {
  const boxes = [finding.left?.box, finding.right?.box].filter(Boolean);
  const x = Math.min(width - 1, Math.max(0, Math.floor(Math.min(...boxes.map(box => box.x)))));
  const y = Math.min(height - 1, Math.max(0, Math.floor(Math.min(...boxes.map(box => box.y)))));
  return { x, y, width: Math.max(1, Math.min(width - x, Math.ceil(Math.max(...boxes.map(box => box.x + box.width))) - x)), height: Math.max(1, Math.min(height - y, Math.ceil(Math.max(...boxes.map(box => box.y + box.height))) - y)) };
}
