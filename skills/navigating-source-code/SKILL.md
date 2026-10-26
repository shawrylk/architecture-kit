---
name: navigating-source-code
description: "Use when you need to understand source code before editing it: finding the code for a concept, a symbol's callers and callees, or the blast radius of a change, before falling back to the Claude Code `Grep` and `Glob` tools."
---

# Source code navigation

The `gitnexus` MCP (knowledge graph) is optional. When available, use it to understand source code:

1. `gitnexus_query({query: "concept"})` — find execution flows / relevant code by concept
2. `gitnexus_context({name: "symbolName"})` — full context on a symbol (callers, callees, flows)
3. `gitnexus_impact({target: "symbolName", direction: "upstream"})` — blast radius before editing a symbol
4. `gitnexus_detect_changes()` — verify affected scope before committing

When the graph is unavailable or its results are insufficient, use the Claude Code `Grep` and `Glob` tools.
Use them to find files, symbols, and callers.
Read the matching code and its tests to check the effect of a change before editing.
