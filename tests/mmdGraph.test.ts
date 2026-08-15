// Checks the .mmd parser against the real diagrams: the arrow count is the ground truth.
// Run alone: node --test tests/mmdGraph.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseMmd, enumeratePaths } from "../scripts/mmdGraph.ts";

const DIAGRAM_DIR = join(import.meta.dirname, "..", "plans", "diagram");
const diagramFiles = readdirSync(DIAGRAM_DIR).filter((f) => f.endsWith(".mmd")).sort();

const countArrows = (text: string): number =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("%%"))
    .join("\n")
    .match(/-->|-\.->/g)?.length ?? 0;

test("parses every edge form the diagrams use", () => {
  const g = parseMmd(`flowchart TB
  %% a comment --> ignored
  A["alpha"] --> B{"is it?"}
  B -- "yes<br/>please" --> C["gamma"]
  A -.-> C
  C --> D["delta"] --> E["epsilon"]
  classDef script fill:#000
  class A,B script`);

  assert.deepEqual([...g.nodes.keys()], ["A", "B", "C", "D", "E"]);
  assert.equal(g.nodes.get("B"), "is it?");
  assert.deepEqual(g.edges, [
    { from: "A", to: "B", label: undefined },
    { from: "B", to: "C", label: "yes\nplease" },
    { from: "A", to: "C", label: undefined },
    { from: "C", to: "D", label: undefined },
    { from: "D", to: "E", label: undefined },
  ]);
});

test("finds at least one diagram to check", () => {
  assert.ok(diagramFiles.length >= 6, `only found ${diagramFiles.length} .mmd files`);
});

for (const file of diagramFiles) {
  test(`${file}: edge count matches the arrows in the file`, () => {
    const text = readFileSync(join(DIAGRAM_DIR, file), "utf8");
    assert.equal(parseMmd(text).edges.length, countArrows(text));
  });

  test(`${file}: every node carries a label from the diagram`, () => {
    const g = parseMmd(readFileSync(join(DIAGRAM_DIR, file), "utf8"));
    const unlabeled = [...g.nodes].filter(([id, label]) => id === label).map(([id]) => id);
    assert.deepEqual(unlabeled, [], `nodes with no label text: ${unlabeled.join(", ")}`);
  });

  test(`${file}: paths start at a root, end at a sink, and reuse no edge more than twice`, () => {
    const g = parseMmd(readFileSync(join(DIAGRAM_DIR, file), "utf8"));
    const outgoing = new Set(g.edges.map((e) => e.from));
    const incoming = new Set(g.edges.map((e) => e.to));
    const paths = enumeratePaths(g, 2);

    assert.ok(paths.length > 0, "no paths found");
    for (const path of paths) {
      assert.ok(!incoming.has(path[0]), `path starts mid-graph at ${path[0]}`);
      assert.ok(!outgoing.has(path.at(-1)!), `path ends at non-sink ${path.at(-1)}`);
      const uses = new Map<string, number>();
      for (let i = 1; i < path.length; i++) {
        const key = `${path[i - 1]}>${path[i]}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
        assert.ok(uses.get(key)! <= 2, `edge ${key} used ${uses.get(key)} times`);
      }
    }
  });
}
