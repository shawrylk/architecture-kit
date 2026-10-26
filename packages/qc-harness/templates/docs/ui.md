# UI

## Parity

Visual parity with whatever this replaces is the default. Divergence is argued in the work order,
with a before and after.

## Presenters — QC-010

A view gathers input and invokes a headless workflow. It does not orchestrate. The
`no-orchestration-in-trigger` rule is what holds this: more than one `await` in a presenter is the
signal that a workflow belongs behind it.

## Realtime — ADR-0048

A frame names a row; the client invalidates and refetches. Frames carry notifications, not data, so
a missed frame costs a refetch rather than a divergence.

## Cancellation — ADR-0038

The cancellation token is the last parameter of every function that can outlive the interaction. A
write is never cancelled by navigation.

## Accessibility — ADR-0040

WCAG 2.2 AA. Every drag has a non-drag equivalent. The focus ring is never removed.

## Hot loops

Data-oriented discipline applies to any hot loop: per frame, or over a large item count, or
allocating per iteration on the interaction thread. Assert it by measuring allocation, not by
reading the code.

## Adopt the UI lint rules

Enable these five rules under `rules` in `qc.config.json`:

- `one-component-per-file`
- `raw-element-in-primitive`
- `no-arbitrary-class-value`
- `no-literal-color`
- `no-static-inline-style`

The preset applies them to `clientFiles`. The primitive folders come from `ui.layers.primitive`.
Use classes and theme tokens for static presentation. Inline styles with runtime values, such as `style={{ width: size }}`, pass.
An object with only literal values, such as `style={{ width: 12 }}`, fails `qc/no-static-inline-style`.

For an existing frontend, use ESLint 9.24 or later; the kit uses ESLint 9.39.
`eslint --suppress-rule <rule>` writes `eslint-suppressions.json` as the sole lint baseline.
Create the initial baseline, then commit it:

```sh
npx eslint frontend/src --suppress-rule qc/one-component-per-file --suppress-rule qc/raw-element-in-primitive --suppress-rule qc/no-arbitrary-class-value --suppress-rule qc/no-literal-color --suppress-rule qc/no-static-inline-style
```

After adoption, run `npx eslint frontend/src` without suppression-generation flags. Findings beyond the baseline counts fail.
An unused suppression fails by default; keep that check enabled.
After you fix findings, run `npx eslint frontend/src --prune-suppressions` and commit the smaller file.
The baseline may only shrink: accept removals and lower counts.
