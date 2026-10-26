// A fragment that edits shared TOML assignments without rewriting other text.

export const CODEX_KEYS = Object.freeze([
  "approval_policy", "default_permissions", "model", "model_reasoning_effort",
  "model_auto_compact_token_limit", "model_post_turn_compact_threshold_percent", "service_tier",
]);

function unquote(value) {
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1);
  return value;
}

function scanValue(text, start, inline = false) {
  let quote = "";
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (quote.includes('"') && char === "\\") { i += 1; continue; }
      if (text.startsWith(quote, i)) { i += quote.length - 1; quote = ""; }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = text.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      i += quote.length - 1;
    } else if (inline && depth === 0 && (char === "," || char === "}")) return { end: i, next: i + 1 };
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "#") {
      if (depth === 0) return { end: i, next: text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i) + 1 };
      const newline = text.indexOf("\n", i);
      if (newline < 0) break;
      i = newline - 1;
    } else if (char === "\n" && depth === 0) return { end: i, next: i + 1 };
  }
  if (quote || depth !== 0) throw new Error("Unterminated TOML value");
  return { end: text.length, next: text.length };
}

function documentOf(text) {
  const sections = [{ name: "", start: 0, end: text.length, fields: new Map() }];
  let section = sections[0];
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const next = newline < 0 ? text.length : newline + 1;
    const line = text.slice(offset, next).trimEnd();
    const header = /^\s*(\[\[?.*?\]\]?)\s*(?:#.*)?$/.exec(line);
    if (header) {
      section.end = offset;
      const named = /^\[\s*(plugins|marketplaces)\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\s*\]$/.exec(header[1]);
      section = { name: header[1], kind: named?.[1], plugin: named && unquote(named[2]), start: offset, end: text.length, fields: new Map() };
      sections.push(section);
    } else {
      const assignment = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)((?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+))*)\s*=\s*/.exec(line);
      if (assignment) {
        const key = assignment[2] ? `${assignment[1]}${assignment[2]}` : unquote(assignment[1]);
        const start = offset + assignment[0].length;
        const value = scanValue(text, start);
        const raw = text.slice(start, value.end).trimEnd();
        if (section.fields.has(key)) throw new Error(`Duplicate TOML key: ${key}`);
        section.fields.set(key, { start, end: start + raw.length, raw, parts: keyParts(`${assignment[1]}${assignment[2]}`) });
        offset = value.next;
        continue;
      }
    }
    offset = next;
  }
  return sections;
}

function keyParts(key) {
  return [...key.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+/g)].map(([part]) => unquote(part));
}

// A fragment that locates plugin fields in dotted assignments and inline tables.
function pluginTarget(section, parts, text, form = "dotted plugin assignment") {
  if (!parts.length) return { ...section, fields: new Map([...section.fields].map(([key, field]) => [field.parts?.[0] ?? key, field])), prefix: [] };
  const fields = new Map();
  for (const [key, field] of section.fields) {
    const path = field.parts ?? keyParts(key);
    const common = Math.min(path.length, parts.length);
    if (!path.slice(0, common).every((part, i) => part === parts[i])) continue;
    if (path.length <= parts.length) {
      const kind = form === "[plugins] table" ? form : path.length === 1 ? "top-level inline plugins table" : "dotted inline plugin table";
      const line = text.slice(0, field.start).split("\n").length;
      if (!field.raw.startsWith("{")) throw new Error(`Cannot merge ${kind} at line ${line}: expected an inline table.`);
      const nested = { fields: new Map(), end: field.end - 1, inline: true };
      let offset = field.start + 1;
      while (offset < nested.end) {
        const assignment = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)((?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+))*)\s*=\s*/.exec(text.slice(offset, nested.end));
        if (!assignment) break;
        const start = offset + assignment[0].length;
        const value = scanValue(text, start, true);
        const raw = text.slice(start, value.end).trimEnd();
        const name = `${assignment[1]}${assignment[2]}`;
        nested.fields.set(name, { start, end: start + raw.length, raw, parts: keyParts(name) });
        offset = value.next;
      }
      return pluginTarget(nested, parts.slice(path.length), text, kind)
        ?? { ...nested, prefix: parts.slice(path.length) };
    }
    if (path.length === parts.length + 1) fields.set(path.at(-1), field);
    else throw new Error(`Cannot merge ${form} at line ${text.slice(0, field.start).split("\n").length}: expected a plugin field.`);
  }
  return fields.size ? { ...section, fields, prefix: parts } : null;
}

function sharedFields(text) {
  const sections = documentOf(text);
  const top = new Map([...sections[0].fields].filter(([key]) => CODEX_KEYS.includes(key)));
  const local = new Set(sections.filter((s) => s.kind === "marketplaces" && (
    s.fields.get("source_type")?.raw.match(/^["']local["']$/)
    || s.fields.get("source")?.raw.match(/^["'](?:[A-Za-z]:|[\\/~.])/)
  )).map((s) => s.plugin));
  const plugins = sections.filter((s) => s.kind === "plugins" && !local.has(s.plugin.split("@").at(-1)))
    .map((s) => ({ ...s, fields: new Map([...s.fields].filter(([key]) => key === "enabled")) }))
    .filter((s) => s.fields.size);
  for (const [key, field] of top) {
    if (!/^(?:"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|\d+)$/.test(field.raw)) {
      throw new Error(`Expected a scalar shared TOML value: ${key}`);
    }
  }
  for (const plugin of plugins) {
    if (!/^(true|false)$/.test(plugin.fields.get("enabled").raw)) throw new Error(`Expected a plugin boolean: ${plugin.plugin}`);
  }
  return { top, plugins };
}

export function captureCodexConfig(text) {
  const { top, plugins } = sharedFields(text);
  const rows = [...top].map(([key, value]) => `${key} = ${value.raw}`);
  for (const plugin of plugins) rows.push("", `[plugins.${JSON.stringify(plugin.plugin)}]`, `enabled = ${plugin.fields.get("enabled").raw}`);
  return rows.length ? `${rows.join("\n")}\n` : "";
}

export function mergeCodexConfig(local, shared) {
  const sections = documentOf(local);
  const desired = sharedFields(shared);
  const edits = [];
  const additions = new Map();
  const inlineAdditions = new Map();
  const newTables = [];
  const changed = [];
  const eol = local.includes("\r\n") ? "\r\n" : "\n";
  function add(section, line) {
    additions.set(section, [...(additions.get(section) ?? []), line]);
  }
  function merge(section, fields, label) {
    for (const [key, value] of fields) {
      const previous = section.fields.get(key);
      if (previous && unquote(previous.raw) === unquote(value.raw)) continue;
      changed.push(`${label}${key}`);
      if (previous) edits.push({ start: previous.start, end: previous.end, text: value.raw });
      else {
        const name = [...(section.prefix ?? []), key].map((part) => JSON.stringify(part)).join(".");
        if (section.inline) {
          const entry = inlineAdditions.get(section.end) ?? { populated: section.fields.size > 0, lines: [] };
          entry.lines.push(`${name} = ${value.raw}`);
          inlineAdditions.set(section.end, entry);
        } else add(section, `${section.prefix ? name : key} = ${value.raw}`);
      }
    }
  }
  merge(sections[0], desired.top, "");
  for (const plugin of desired.plugins) {
    const matches = sections.filter((s) => s.kind === "plugins" && s.plugin === plugin.plugin);
    if (matches.length > 1) throw new Error(`Duplicate plugin table: ${plugin.plugin}`);
    if (matches.length) merge(matches[0], plugin.fields, `plugins.${plugin.plugin}.`);
    else {
      const parent = sections.find((s) => /^\[\s*(?:plugins|"plugins"|'plugins')\s*\]$/.test(s.name));
      const target = pluginTarget(sections[0], ["plugins", plugin.plugin], local)
        ?? (parent && (pluginTarget(parent, [plugin.plugin], local, "[plugins] table") ?? { ...parent, prefix: [plugin.plugin] }));
      if (target) {
        merge(target, plugin.fields, `plugins.${plugin.plugin}.`);
        const lines = additions.get(target);
        if (lines) edits.push({ start: target.end, end: target.end,
          text: `${target.end && local[target.end - 1] !== "\n" ? eol : ""}${lines.join(eol)}${eol}` });
        continue;
      }
      const section = { fields: new Map() };
      newTables.push(section);
      add(section, `[plugins.${JSON.stringify(plugin.plugin)}]`);
      merge(section, plugin.fields, `plugins.${plugin.plugin}.`);
    }
  }
  for (const [end, entry] of inlineAdditions) {
    edits.push({ start: end, end, text: `${entry.populated ? ", " : ""}${entry.lines.join(", ")} ` });
  }
  for (const section of sections) {
    const lines = additions.get(section);
    if (lines) edits.push({ start: section.end, end: section.end,
      text: `${section.end && local[section.end - 1] !== "\n" ? eol : ""}${lines.join(eol)}${eol}` });
  }
  let text = local;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  for (const section of newTables) text += `${text && !text.endsWith("\n") ? eol : ""}${eol}${additions.get(section).join(eol)}${eol}`;
  return { text, changed };
}
