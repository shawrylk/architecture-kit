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

function scanValue(text, start) {
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
    } else if (char === "[" || char === "{") depth += 1;
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
        section.fields.set(key, { start, end: start + raw.length, raw });
        offset = value.next;
        continue;
      }
    }
    offset = next;
  }
  return sections;
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
  if (sections[0].fields.get("plugins")?.raw.startsWith("{")) {
    throw new Error('Inline TOML plugins tables are unsupported; use [plugins."name"] tables.');
  }
  const desired = sharedFields(shared);
  const edits = [];
  const additions = new Map();
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
      else add(section, `${key} = ${value.raw}`);
    }
  }
  merge(sections[0], desired.top, "");
  for (const plugin of desired.plugins) {
    const matches = sections.filter((s) => s.kind === "plugins" && s.plugin === plugin.plugin);
    if (matches.length > 1) throw new Error(`Duplicate plugin table: ${plugin.plugin}`);
    if (matches.length) merge(matches[0], plugin.fields, `plugins.${plugin.plugin}.`);
    else {
      const section = { fields: new Map() };
      newTables.push(section);
      add(section, `[plugins.${JSON.stringify(plugin.plugin)}]`);
      merge(section, plugin.fields, `plugins.${plugin.plugin}.`);
    }
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
