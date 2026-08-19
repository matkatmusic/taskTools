// Parses plans/diagram/*.mmd flowcharts into a graph, lists every path, and names every box.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
/*
  The diagrams are the single source of truth; nothing here invents wording.
*/

export type MmdNode = { id: string; label: string };
export type MmdEdge = { from: string; to: string; label?: string };
// labelled holds every id declared with a shape, so id-equals-label is not read as none.
// classes holds every id named on a `class A,B kind` line, which is what the step loop dispatches on.
export type MmdGraph = { nodes: Map<string, string>; edges: MmdEdge[]; labelled: Set<string>; classes: Map<string, string> };

const SKIP = /^\s*(%%|flowchart\b|graph\b|classDef\b|class\b|subgraph\b|end\b|linkStyle\b|style\b|$)/;
const CLASS_LINE = /^\s*class\s+([A-Za-z0-9_,\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/;

const NODE = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\["[^"]*"\]|\[[^\]]*\]|\{"[^"]*"\}|\{[^}]*\}|\("[^"]*"\)|\([^)]*\))?/;
const ARROW = /^\s*(?:--\s*"([^"]*)"\s*)?(-->|-\.->)\s*/;

function labelOf(shape: string | undefined, id: string): string {
  if (!shape) return id;
  const inner = shape.slice(1, -1).trim();
  const unquoted = inner.startsWith('"') && inner.endsWith('"') ? inner.slice(1, -1) : inner;
  return unquoted.replaceAll("<br/>", "\n").replaceAll("<br>", "\n");
}

export function parseMmd(text: string): MmdGraph {
  const nodes = new Map<string, string>();
  const edges: MmdEdge[] = [];
  const labelled = new Set<string>();
  const classes = new Map<string, string>();

  for (const line of text.split("\n")) {
    const classLine = CLASS_LINE.exec(line);
    if (classLine) for (const id of classLine[1]!.split(",")) classes.set(id.trim(), classLine[2]!);
    if (SKIP.test(line)) continue;
    let rest = line.trim();
    let prev: string | null = null;
    let pendingLabel: string | undefined;

    while (rest.length > 0) {
      const n = NODE.exec(rest);
      if (!n) break;
      const [, id, shape] = n;
      if (shape || !nodes.has(id)) nodes.set(id, labelOf(shape, id));
      if (shape) labelled.add(id);
      if (prev) edges.push({ from: prev, to: id, label: pendingLabel });
      prev = id;
      pendingLabel = undefined;
      rest = rest.slice(n[0].length);

      const a = ARROW.exec(rest);
      if (!a) break;
      pendingLabel = a[1] ? a[1].replaceAll("<br/>", "\n") : undefined;
      rest = rest.slice(a[0].length);
    }
  }
  return { nodes, edges, labelled, classes };
}

/*
  The one node that follows `nodeId`. A decision needs the `outcome` its evaluator
  returned; the YES/NO node carrying that outcome is hopped through, not returned.
*/
export function stepAfter(g: MmdGraph, nodeId: string, outcome?: string): string {
  const children = g.edges.filter((e) => e.from === nodeId).map((e) => e.to);
  if (children.length === 0) throw new Error(`mmdGraph: "${nodeId}" has no next node`);
  const target = children.length === 1
    ? children[0]!
    : children.find((id) => g.nodes.get(id) === outcome);
  if (!target) throw new Error(`mmdGraph: "${nodeId}" has no arm labelled ${JSON.stringify(outcome)}`);
  const kind = g.classes.get(target);
  if (kind === "pass" || kind === "nopass") return stepAfter(g, target);
  return target;
}

/*
  Every root-to-sink walk that uses no edge more than `maxEdgeUses` times.
*/
export function enumeratePaths(g: MmdGraph, maxEdgeUses = 2, cap = 200_000): string[][] {
  const out = new Map<string, MmdEdge[]>();
  const hasIncoming = new Set<string>();
  for (const e of g.edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    hasIncoming.add(e.to);
  }
  const roots = [...g.nodes.keys()].filter((id) => !hasIncoming.has(id));

  const paths: string[][] = [];
  const uses = new Map<MmdEdge, number>();

  const walk = (node: string, trail: string[]): void => {
    if (paths.length >= cap) return;
    const next = out.get(node);
    if (!next) {
      paths.push([...trail]);
      return;
    }
    for (const e of next) {
      const used = uses.get(e) ?? 0;
      if (used >= maxEdgeUses) continue;
      uses.set(e, used + 1);
      trail.push(e.to);
      walk(e.to, trail);
      trail.pop();
      uses.set(e, used);
    }
  };

  for (const r of roots) walk(r, [r]);
  return paths;
}

// Every diagram the pipeline walks. Order is the order a run visits them.
export const DIAGRAM_FILES = [
  "pipeline-preambleStatusCheck.mmd",
  "pipeline-worktreeCheck.mmd",
  "pipeline-documentGeneration.mmd",
  "pipeline-plan.mmd",
  "pipeline-reviewPlan.mmd",
  "pipeline-implement.mmd",
  "pipeline-taskTests.mmd",
  "pipeline-reviewTests.mmd",
  "pipeline-rebasePreamble.mmd",
  "pipeline-rebase.mmd",
  "pipeline-suite.mmd",
  "pipeline-merge.mmd",
  "pipeline-mergeSucceededExit.mmd",
  "pipeline-failuresExit.mmd",
  "pipeline-reportOnlyExit.mmd",
  "pipeline.mmd",
];

// Built at module load: every diagram node id mapped to its label. Conflicting labels throw.
export const nodeLabels = new Map<string, string>();
// The same diagrams as one graph, which is what stepAfter walks for the /run-step loop.
export const pipelineGraph: MmdGraph = { nodes: nodeLabels, edges: [], labelled: new Set(), classes: new Map() };
for (const file of DIAGRAM_FILES) {
  const path = fileURLToPath(new URL(`../plans/diagram/${file}`, import.meta.url));
  const { nodes, edges, classes } = parseMmd(readFileSync(path, "utf8"));
  pipelineGraph.edges.push(...edges);
  for (const [id, kind] of classes) pipelineGraph.classes.set(id, kind);
  for (const [id, label] of nodes) {
    const existing = nodeLabels.get(id);
    if (existing !== undefined && existing !== label) {
      throw new Error(`mmdGraph: node "${id}" has conflicting labels across diagrams: ${JSON.stringify(existing)} vs ${JSON.stringify(label)}`);
    }
    nodeLabels.set(id, label);
  }
}

// A diagram node label, on one line. Throws immediately on a typo'd id.
export const L = (id: string): string => {
  const label = nodeLabels.get(id);
  if (label === undefined) throw new Error(`mmdGraph: no diagram node named "${id}"`);
  return label.replaceAll("\n", " ");
};
