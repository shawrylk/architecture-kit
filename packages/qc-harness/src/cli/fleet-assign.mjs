import { ownerOf } from "./fleet.mjs";

/** Human-readable reasons for withholding new work; unknown metrics never count. */
export function overloaded(load) {
  const reasons = [];
  if (load?.cpu != null && load.cpu >= 0.9) reasons.push(`cpu ${Math.round(load.cpu * 100)}%`);
  if (load?.platform !== "darwin" && load?.mem != null && load.mem >= 0.9) reasons.push(`mem ${Math.round(load.mem * 100)}%`);
  if (load?.rtt != null && load.rtt >= 2000) reasons.push(`rtt ${load.rtt}ms`);
  return reasons;
}

/** Keep open work stable and give each idle, compatible live node one issue. */
export function assignTick({ fleet, repo, open, free, assignments, peers, kit, now }) {
  const kept = Object.fromEntries(Object.entries(assignments).filter(([, row]) => row.repo !== repo || open.has(row.issue)));
  const messages = [], warnings = [];
  const busy = new Set(Object.values(kept).map(row => row.node));
  const idle = fleet.nodes.filter(node => {
    const reasons = overloaded(peers[node.id]?.load);
    if (reasons.length) warnings.push(`node ${node.id} is overloaded: ${reasons.join(", ")}`);
    if (reasons.length) return false;
    if (node.id === fleet.self) return !busy.has(node.id);
    const peer = peers[node.id];
    if (peer && peer.kit !== kit) warnings.push(`node ${node.id} runs kit ${peer.kit}, leader runs ${kit}`);
    return !busy.has(node.id) && node.active !== false && node.address && peer?.kit === kit &&
      Number.isFinite(peer?.time) && now - peer.time >= 0 && now - peer.time < 90_000;
  }).map(node => node.id === fleet.self ? { ...node, active: true } : node);
  // Recover held work before offering fresh issues to the remaining idle nodes.
  for (const [key, row] of Object.entries(kept)) {
    if (row.repo !== repo || row.node === fleet.self) continue;
    const lastSeen = peers[row.node]?.time ?? row.time;
    if (Number.isFinite(lastSeen) && now - lastSeen < 90_000) continue;
    const size = row.size ?? free.find(issue => issue.number === row.issue)?.size ?? "M";
    const node = ownerOf(repo, row.issue, size, idle.filter(node => !busy.has(node.id)));
    if (!node) { warnings.push(`#${row.issue} waits: node ${row.node} is dead`); continue; }
    const work = peers[row.node]?.work?.find(work => work.repo === repo && work.issue === row.issue && work.epoch === row.epoch);
    const { branch: _branch, head: _head, ...previous } = row;
    kept[key] = { ...previous, node, epoch: row.epoch + 1, time: now,
      ...(work?.branch ? { branch: work.branch } : {}), ...(work?.head ? { head: work.head } : {}) };
    busy.add(node);
  }
  const red = row => row.labels.some(label => label.name.toLowerCase() === "ci-red");
  for (const row of [...free].sort((a, b) => Number(red(b)) - Number(red(a)) || a.number - b.number)) {
    const key = `${repo}#${row.number}`;
    if (!open.has(row.number) || kept[key]) continue;
    const node = ownerOf(repo, row.number, row.size, idle.filter(node => !busy.has(node.id)));
    if (!node) continue;
    kept[key] = { repo, issue: row.number, node, epoch: 1, time: now, size: row.size };
    busy.add(node);
  }
  for (const row of Object.values(kept)) {
    if (row.repo !== repo || row.node === fleet.self) continue;
    const node = fleet.nodes.find(node => node.id === row.node), peer = peers[row.node];
    if (node?.active === false || !node?.address || !Number.isFinite(peer?.time) || now - peer.time < 0 || now - peer.time >= 90_000) continue;
    messages.push({ node: row.node, kind: "assign", body: { issue: row.issue, epoch: row.epoch,
      ...(row.branch ? { branch: row.branch } : {}), ...(row.head ? { head: row.head } : {}) } });
  }
  return { assignments: kept, messages, warnings };
}
