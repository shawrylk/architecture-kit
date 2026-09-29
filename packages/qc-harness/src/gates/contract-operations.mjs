// The operations of one API description: method, path, parameters and request-body properties.
// Gates that judge a contract read it here, so none parses the document itself. `yaml` is an
// optional peer, loaded on first use, so a repository with no contract gate never installs it.

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const MAX_HOPS = 5;

/** The package failed to load. Anything else that went wrong is not this error. */
function peerMissing(error) {
  const wrapped = new Error(
    "the contract gates read the API description with the `yaml` package; install it: pnpm add -D yaml",
    { cause: error },
  );
  wrapped.code = "CONTRACT_PEER_MISSING";
  return wrapped;
}

const loadYaml = () => import("yaml");

async function parser(load) {
  try {
    return await load();
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") throw peerMissing(error);
    throw error;
  }
}

/** One segment of a JSON pointer in a URI fragment: percent-decoded, then `~1` and `~0` unescaped. */
function segment(text) {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // A stray % is part of the name.
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * A local `$ref` followed to its target, a few hops at most. Anything else is returned as it is.
 * With `seen`, each ref is followed once: a ref already in it resolves to undefined.
 */
function deref(document, node, seen) {
  let current = node;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const ref = current?.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) return current;
    if (seen?.has(ref)) return undefined;
    seen?.add(ref);
    const target = ref
      .slice(2)
      .split("/")
      .reduce((at, key) => at?.[segment(key)], document);
    if (target === undefined) return undefined;
    current = target;
  }
  return current;
}

/**
 * The property names of a schema. A local `$ref` and each `allOf` part are followed. `seen` holds the
 * refs of one body walk, so a schema reached twice, or one that composes itself, is walked once;
 * the depth is a backstop.
 */
function schemaProps(document, schema, seen, depth = 0) {
  // The cap comes first: a ref reached past it must stay unseen, so a shallower path can still walk it.
  if (depth > MAX_HOPS) return [];
  const resolved = deref(document, schema, seen);
  if (!resolved || typeof resolved !== "object") return [];
  const own = Object.keys(resolved.properties ?? {});
  const composed = (resolved.allOf ?? []).flatMap((part) => schemaProps(document, part, seen, depth + 1));
  return [...new Set([...own, ...composed])];
}

function bodyProps(document, operation) {
  const body = deref(document, operation.requestBody);
  const seen = new Set();
  const media = Object.values(body?.content ?? {});
  return [...new Set(media.flatMap((entry) => schemaProps(document, entry?.schema, seen)))];
}

function paramNames(document, ...lists) {
  const names = lists
    .flatMap((list) => list ?? [])
    .map((param) => deref(document, param)?.name)
    .filter((name) => typeof name === "string");
  return [...new Set(names)];
}

/**
 * @param {string} text the API description, YAML or JSON
 * @param {{load?: () => Promise<{parse: (text: string) => unknown}>}} [options] how the parser is loaded
 * @returns {Promise<{method: string, path: string, id: string, params: string[], bodyProps: string[]}[]>}
 *   method is lower-case; id is the operationId, or `METHOD /path` when the operation has none
 */
export async function contractOperations(text, { load = loadYaml } = {}) {
  const { parse } = await parser(load);
  const document = parse(text) ?? {};
  const operations = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of Object.keys(item ?? {}).filter((key) => METHODS.includes(key))) {
      const operation = item[method];
      if (!operation || typeof operation !== "object") continue;
      operations.push({
        method,
        path,
        id: operation.operationId ?? `${method.toUpperCase()} ${path}`,
        params: paramNames(document, item.parameters, operation.parameters),
        bodyProps: bodyProps(document, operation),
      });
    }
  }
  return operations;
}
