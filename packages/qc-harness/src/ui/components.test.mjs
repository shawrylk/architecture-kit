import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractComponents, firstSentence, layerOf } from "./components.mjs";
import { loadTypeScript } from "./typescript.mjs";

const ts = loadTypeScript();
const extract = (text, rel = "frontend/src/platform/ui/primitives/button.tsx") => extractComponents(ts, rel, text);

test("a layer accepts multiple folders and keeps the longest folder match", () => {
  const options = { layers: { primitive: ["src/ui", "src/shared/primitives"], pattern: "src/ui/patterns" } };
  assert.equal(layerOf("src/ui/button.tsx", options), "primitive");
  assert.equal(layerOf("src/shared/primitives/input.tsx", options), "primitive");
  assert.equal(layerOf("src/ui/patterns/form.tsx", options), "pattern");
  assert.equal(layerOf("src/ui-extra/button.tsx", options), "platform");
});

test("a function component records its name, line, props and first JSDoc sentence", () => {
  const [button] = extract(`import React from "react";
interface ButtonProps { label: string; onPress?: () => void }
/** A pressable control. It shows a spinner while loading. */
export function Button({ label, onPress }: ButtonProps) { return <button onClick={onPress}>{label}</button>; }
`);
  assert.deepEqual(
    { name: button.name, line: button.line, props: button.props, description: button.description },
    { name: "Button", line: 4, props: ["label", "onPress"], description: "A pressable control." },
  );
});

test("a const bound to an arrow, forwardRef and memo is a component", () => {
  const found = extract(`
type Props = { a: string } & { b?: number };
/** Arrow. */
export const Arrow = ({ a }: Props) => <i>{a}</i>;
/** Forwarded. */
export const Forwarded = React.forwardRef<HTMLDivElement, { tone: string }>((props, ref) => <div ref={ref} />);
/** Memoised. */
export const Memoised = memo(function Memoised(props: Props) { return null; });
`);
  assert.deepEqual(
    found.map((c) => [c.name, c.props]),
    [["Arrow", ["a", "b"]], ["Forwarded", ["tone"]], ["Memoised", ["a", "b"]]],
  );
});

test("a lowercase function, a constant and a function that is not exported are skipped", () => {
  const found = extract(`
export function helper() { return 1; }
export const MAX_ITEMS = 5;
function Hidden() { return <i />; }
export const Config = { a: 1 };
`);
  assert.deepEqual(found, []);
});

test("a component exported by a list or as the default is found, with the JSDoc of its declaration", () => {
  const found = extract(`
/** Listed. */
function Listed() { return <i />; }
/** Default one. */
function Fallback() { return <i />; }
export { Listed as Renamed };
export default Fallback;
`);
  assert.deepEqual(found.map((c) => [c.name, c.description]), [["Fallback", "Default one."], ["Renamed", "Listed."]]);
});

test("a component with no JSDoc has an empty description", () => {
  const [one] = extract("export const Bare = () => <i />;\n");
  assert.equal(one.description, "");
});

test("props come from an extended local interface and fall back to the destructured names", () => {
  const found = extract(`
interface Base { id: string }
interface Card extends Base { title: string }
export function CardView(props: Card) { return null; }
export const Loose = ({ x, y: z, ...rest }) => null;
`);
  assert.deepEqual(found.map((c) => c.props), [["title", "id"], ["x", "y"]]);
});

test("firstSentence stops at the first full stop, a paragraph break, or the end", () => {
  assert.equal(firstSentence("One thing. Another."), "One thing.");
  assert.equal(firstSentence("Spans\nlines without a stop\n\nNext paragraph."), "Spans lines without a stop");
  assert.equal(firstSentence("Version 1.2 is fine. Yes."), "Version 1.2 is fine.");
  assert.equal(firstSentence(""), "");
});

test("the layer is the longest configured prefix, then feature:<name>, then platform", () => {
  const options = { layers: { primitive: "frontend/src/platform/ui/primitives", pattern: "frontend/src/platform/ui" } };
  assert.equal(layerOf("frontend/src/platform/ui/primitives/button.tsx", options, "features"), "primitive");
  assert.equal(layerOf("frontend/src/platform/ui/card.tsx", options, "features"), "pattern");
  assert.equal(layerOf("frontend/src/features/photos/components/grid.tsx", options, "features"), "feature:photos");
  assert.equal(layerOf("frontend/src/platform/shell/frame.tsx", options, "features"), "platform");
});
