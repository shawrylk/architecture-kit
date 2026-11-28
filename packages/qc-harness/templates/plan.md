# Plan: {{topic}}

Issue: #{{issue}}
Status: draft
Approved-by: none

## Goal

<!-- State the result and how to check it. -->

## Non-goals

<!-- State what this plan excludes. -->

## Services

<!-- Use one service block with Interface:, Now: and Scale:.
Name the interface file in backticks, its methods, the first implementation,
and the load or size that needs a replacement behind the same interface.
If no service changes, write None: <reason>. -->

## Catalog

<!-- {{catalog}}
List the parts searched, what you reuse, and why each new part has no match. -->

## Change log

<!-- qc plan revalidate writes dated rows here. -->

## Tasks

<!-- Use a heading such as ### Task 1: Change the trigger.
List each file with Create:, Modify:, Test:, Delete: or Rename:.
Add (block: <name>) under a configured feature root and (~N lines) for size.
Use Split: <reason> if the file must exceed plan.fileLines (default 500).
Keep one responsibility per file. Put each service behind an interface.
Use the eight blocks: index, trigger, pipeline, resource, branch, fragment,
ledger and record. Write test steps before code steps, then a commit step.
Use - [ ] **Step 1: Write the failing test** for each step. -->
