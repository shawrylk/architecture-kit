// A fragment: the markers around a generated region of a Markdown file. The enforcement map writes its
// table between them, and the generated-file guard refuses a hand edit inside them.

export const GENERATED_CLOSE = "<!-- /generated -->";
const GENERATED_OPEN = /<!--\s*generated:[^>]*-->/g;

/** @returns each generated region as `[start, end)`, from its open marker through its close marker or the end. */
export function generatedRegions(markdown) {
  const regions = [];
  for (const found of markdown.matchAll(GENERATED_OPEN)) {
    const close = markdown.indexOf(GENERATED_CLOSE, found.index);
    const end = close === -1 ? markdown.length : close + GENERATED_CLOSE.length;
    if (regions.length === 0 || found.index >= regions.at(-1)[1]) regions.push([found.index, end]);
  }
  return regions;
}
