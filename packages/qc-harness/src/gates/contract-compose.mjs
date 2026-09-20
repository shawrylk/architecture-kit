// One API description, composed from the files features own. A feature writes
// `contracts/paths/<name>.yaml` and nothing else; the linted root is generated,
// so no work order edits a shared document. .claude/rules/swarm.md.

/** @param {Record<string, unknown>} into @param {Record<string, unknown>} from */
function mergeDisjoint(into, from, label, owner, owners) {
  for (const key of Object.keys(from)) {
    const held = owners.get(`${label}:${key}`);
    if (held) {
      throw new Error(`${label} '${key}' is declared by both '${held}' and '${owner}'`);
    }
    owners.set(`${label}:${key}`, owner);
    into[key] = from[key];
  }
}

function sortKeys(record) {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

/**
 * @param {Record<string, any>} base the hand-written root: info, servers, security, shared components
 * @param {{owner: string, document: Record<string, any>}[]} slices one per feature
 */
export function composeContract(base, slices) {
  const owners = new Map();
  const paths = {};
  const schemas = { ...(base.components?.schemas ?? {}) };
  for (const { owner, document } of slices) {
    mergeDisjoint(paths, document.paths ?? {}, "path", owner, owners);
    mergeDisjoint(schemas, document.components?.schemas ?? {}, "schema", owner, owners);
  }
  return {
    ...base,
    paths: sortKeys(paths),
    components: { ...base.components, schemas: sortKeys(schemas) },
  };
}
