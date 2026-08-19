// Checks the .mmd parser against the real diagrams: the arrow count is the ground truth.
// Run alone: node --test tests/mmdGraph.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseMmd, enumeratePaths, stepAfter, pipelineGraph } from "../scripts/mmdGraph.ts";

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
    const unlabeled = [...g.nodes.keys()].filter((id) => !g.labelled.has(id));
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

test("test_parseMmd_capturesNodeClasses", () => {
  // Setup: a diagram whose class lines name two scripts, one decision, and one agent.
  const text = `flowchart TB
  A["run it"] --> B{"did it work?"}
  B --> C["ask the agent"]
  C --> D["run it again"]
  classDef script fill:#000
  class A,D script
  class B decision
  class C agent`;

  // Test action: parse it.
  const g = parseMmd(text);

  // Verification step: every classed node reports the class the diagram gave it.
  assert.equal(g.classes.get("A"), "script");
  assert.equal(g.classes.get("D"), "script");
  assert.equal(g.classes.get("B"), "decision");
  assert.equal(g.classes.get("C"), "agent");
});

test("test_stepAfter_followsAScriptToItsOneNextNode", () => {
  // Setup: two scripts joined by a single arrow.
  const g = parseMmd(`flowchart TB
  A["run it"] --> B["run it again"]
  class A,B script`);

  // Test action: ask what follows the first script.
  // Verification step: the walker names the second script.
  assert.equal(stepAfter(g, "A"), "B");
});

test("test_stepAfter_hopsThroughADecisionOutcomeToTheRealNextNode", () => {
  // Setup: a decision whose YES and NO arms each pass through an outcome node.
  const g = parseMmd(`flowchart TB
  D{"did it work?"} --> D_YES["YES"]
  D --> D_NO["NO"]
  D_YES --> GOOD["carry on"]
  D_NO --> BAD["give up"]
  class D decision
  class D_YES pass
  class D_NO nopass
  class GOOD,BAD script`);

  // Test action: ask what follows the decision for each outcome.
  // Verification step: the outcome nodes are hopped through, not returned.
  assert.equal(stepAfter(g, "D", "YES"), "GOOD");
  assert.equal(stepAfter(g, "D", "NO"), "BAD");
});

test("test_stepAfter_countsDistinctSuccessorsSoADuplicatedEdgeNeedsNoOutcome", () => {
  // Setup: two diagrams both draw A --> B, so the merged graph holds that edge twice.
  const merged = parseMmd(`flowchart TB
  A["run it"] --> B["run it again"]
  A --> B
  class A,B script`);

  // Test action: ask what follows A without naming an outcome.
  // Verification: one distinct successor is followed, rather than demanded as an arm label.
  assert.equal(stepAfter(merged, "A"), "B");
});

test("test_stepAfter_entersTheDiagramAPipelineNodeNames", () => {
  // Setup: the real merged graph. In pipeline-rebasePreamble.mmd the lock's YES arm
  // leads to REBASE_PIPELINE, which is the name of pipeline-rebase.mmd, not a runnable node.
  // Test action: follow that decision's YES arm.
  const next = stepAfter(pipelineGraph, "WAS_LOCK_ACQUIRED", "YES");

  // Verification: the walk lands on the entry node of pipeline-rebase.mmd.
  assert.equal(next, "SOURCE_REPO_LOCKED_INPUT");
});

test("test_stepAfter_entersTheTwoPipelinesWhoseNameDoesNotMatchTheirFile", () => {
  // Setup: EXIT_WORKFLOW_SUCCESS names pipeline-mergeSucceededExit.mmd, and PREAMBLE_PIPELINE
  // names pipeline-preambleStatusCheck.mmd. Neither follows the strip-and-camel-case rule.
  // Test action + Verification: each still lands on its own diagram's entry node.
  assert.equal(stepAfter(pipelineGraph, "MERGE_SUCCESS"), "MERGE_RECEIPT_INPUT");

  const toPreamble = parseMmd(`flowchart TB
  X["start"] --> PREAMBLE_PIPELINE["preamble status check pipeline"]
  class X script
  class PREAMBLE_PIPELINE pipeline`);
  assert.equal(stepAfter(toPreamble, "X"), "TASK_NUMBER_INPUT");
});
