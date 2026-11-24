import { ownerOf } from "./fleet.mjs";

/** Keep open work stable and give each idle, compatible live node one issue. */
export function assignTick({ fleet, repo, open, free, assignments, peers, kit, now }) {
  const kept = Object.fromEntries(Object.entries(assignments).filter(([, row]) => row.repo !== repo || open.has(row.issue)));
  const messages = [], warnings = [];
  const busy = new Set(Object.values(kept).map(row => row.node));
  const idle = fleet.nodes.filter(node => {
    if (node.id === fleet.self) return !busy.has(node.id);
    const peer = peers[node.id];
    if (peer && peer.kit !== kit) warnings.push(`node ${node.id} runs kit ${peer.kit}, leader runs ${kit}`);
    return !busy.has(node.id) && node.active !== false && node.address && peer?.kit === kit &&
      Number.isFinite(peer?.time) && now - peer.time >= 0 && now - peer.time <= 90_000;
  }).map(node => node.id === fleet.self ? { ...node, active: true } : node);
  const red = row => row.labels.some(label => label.name.toLowerCase() === "ci-red");
  for (const row of [...free].sort((a, b) => Number(red(b)) - Number(red(a)) || a.number - b.number)) {
    const key = `${repo}#${row.number}`;
    if (!open.has(row.number) || kept[key]) continue;
    const node = ownerOf(repo, row.number, row.size, idle.filter(node => !busy.has(node.id)));
    if (!node) continue;
    kept[key] = { repo, issue: row.number, node, epoch: 1, time: now };
    busy.add(node);
    if (node !== fleet.self) messages.push({ node, kind: "assign", body: { issue: row.number, epoch: 1 } });
  }
  return { assignments: kept, messages, warnings };
}
