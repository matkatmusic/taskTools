// Parses the plans/diagram/*.mmd flowcharts into a graph and lists every path through it.  The diagrams are the single source of truth; nothing here invents wording.

export type MmdNode = { id: string; label: string };
export type MmdEdge = { from: string; to: string; label?: string };
// labelled holds every id declared with a shape, so a label equal to its id is not mistaken for none.
export type MmdGraph = { nodes: Map<string, string>; edges: MmdEdge[]; labelled: Set<string> };

const SKIP = /^\s*(%%|flowchart\b|graph\b|classDef\b|class\b|subgraph\b|end\b|linkStyle\b|style\b|$)/;

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

  for (const line of text.split("\n")) {
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
  return { nodes, edges, labelled };
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
