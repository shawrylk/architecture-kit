---
name: navigating-source-code
description: "Use when you need to understand source code before editing it: finding the code for a concept, a symbol's callers and callees, or the blast radius of a change, before falling back to Grep, Glob, or find."
---

# Source code navigation

Always use the `gitnexus` MCP (knowledge graph) to understand source code before falling back to `Grep`, `Glob`, or `Bash` find/ls commands:

1. `gitnexus_query({query: "concept"})` — find execution flows / relevant code by concept
2. `gitnexus_context({name: "symbolName"})` — full context on a symbol (callers, callees, flows)
3. `gitnexus_impact({target: "symbolName", direction: "upstream"})` — blast radius before editing a symbol
4. `gitnexus_detect_changes()` — verify affected scope before committing

Only use `Grep`, `Glob`, or `Bash find/ls` when the graph search is insufficient or unavailable.
