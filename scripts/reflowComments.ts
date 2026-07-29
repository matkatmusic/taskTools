// clang-format for `//` prose: rejoin wrapped comment runs onto one line, leaving commented-out code untouched.
import { readFileSync, writeFileSync } from "node:fs";

const COMMENT = /^(\s*)\/\/ ?(.*)$/;
const MACHINE_DIRECTIVE = /^(eslint-|@ts-|prettier-|biome-|#region|#endregion|c8 |istanbul |v8 )/;
const PARAGRAPH_MARK = /^ponytail:/; // joined like prose, but exempt from the word cap
const DIVIDER = /^[-=*_#]{3,}/; // `---- section ----`: hand-formatted, passed through verbatim
const WORD_LIMIT = 20;

export type Reflow = {
  start: number; end: number; line: number; words: number; joined: boolean; capped: boolean;
};

// Trailing `;` and `)` are left out: wrapped prose ends lines that way too.
function looksLikeCode(body: string): boolean {
  return (
    /[{}]$|=>$/.test(body) ||
    /^[)}\]]/.test(body) ||
    /^(const|let|var|function|if|else|for|while|do|return|import|export|class|await|try|catch|switch|case|throw|new|type|interface)(?=[\s;({]|$)/.test(body) ||
    /^[\w.$]+\s*[:=].*[,;:{]$/.test(body) ||
    /^[\w.$]+\(.*[;,){]$/.test(body)
  );
}

// A blank `//` or a directive begins a new comment instead of poisoning the run above it.
const startsNewRun = (body: string) =>
  body === "" || DIVIDER.test(body) || MACHINE_DIRECTIVE.test(body) || PARAGRAPH_MARK.test(body);

// Two spaces after a sentence-ending line, one space otherwise.
function joinBodies(bodies: string[]): string {
  return bodies.reduce((acc, body) => acc + (/[.!?]["')\]]?$/.test(acc) ? "  " : " ") + body);
}

function runIsProse(bodies: string[]): boolean {
  return (
    bodies.length > 0 &&
    !MACHINE_DIRECTIVE.test(bodies[0]) &&
    bodies.every((body) => !looksLikeCode(body))
  );
}

export function reflowSource(source: string): { text: string; runs: Reflow[] } {
  const lines = source.split("\n");
  const out: string[] = [];
  const runs: Reflow[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i].match(COMMENT);
    // A bare `//` or a `---- section ----` rule separates comments, it never starts one.
    if (!head || head[2].trim() === "" || DIVIDER.test(head[2].trim())) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const [, indent] = head;
    let end = i;
    const bodies: string[] = [head[2].trim()];
    while (end + 1 < lines.length) {
      const next = lines[end + 1].match(COMMENT);
      if (!next || next[1] !== indent || startsNewRun(next[2].trim())) break;
      bodies.push(next[2].trim());
      end += 1;
    }
    if (runIsProse(bodies)) {
      const text = joinBodies(bodies);
      const words = text.split(/\s+/).length;
      const joined = bodies.length > 1;
      const capped = !PARAGRAPH_MARK.test(bodies[0]);
      // An already-flat comment is only worth reporting when it busts the cap.
      if (joined || (capped && words >= WORD_LIMIT)) {
        runs.push({ start: i + 1, end: end + 1, line: out.length + 1, words, joined, capped });
      }
      out.push(`${indent}// ${text}`);
    } else {
      out.push(...lines.slice(i, end + 1));
    }
    i = end + 1;
  }
  return { text: out.join("\n"), runs };
}

export type FileReflow = { path: string; runs: Reflow[] };

function showCommand(path: string, lines: number[]): string {
  return `nl -ba '${path}' | sed -n '${lines.map((line) => `${line}p`).join(";")}'`;
}

const overCapLines = ({ path, runs }: FileReflow) =>
  ({ path, lines: runs.filter((run) => run.capped && run.words >= WORD_LIMIT).map((run) => run.line) });

export const needsRewrite = (files: FileReflow[]) => files.some((f) => overCapLines(f).lines.length > 0);

// A JSON string, so the receiving agent parses instead of reasoning about prose.
export function describeReflows(files: FileReflow[]): string {
  const overCap = files.map(overCapLines).filter(({ lines }) => lines.length > 0);
  const rewritten = files
    .map(({ path, runs }) => ({ file: path, lines: runs.filter((run) => run.joined).map((run) => run.line) }))
    .filter(({ lines }) => lines.length > 0);
  return JSON.stringify({
    ...(rewritten.length > 0 && {
      information: "the following lines were rewritten by a hook after your edit",
      rewritten,
    }),
    ...(overCap.length > 0 && {
      instruction: `Rewrite each comment below to under ${WORD_LIMIT} words, keeping it on one line.`,
      files: overCap.map(({ path, lines }) => ({ path, lines, show: showCommand(path, lines) })),
    }),
  });
}

export function reflowFile(path: string): Reflow[] {
  const source = readFileSync(path, "utf8");
  const { text, runs } = reflowSource(source);
  if (runs.length > 0 && text !== source) writeFileSync(path, text);
  return runs;
}

// Reports every reflow; blocks only when a joined comment is still over the cap.
export function emitReflows(hookEventName: string, files: FileReflow[]): boolean {
  const reflowed = files.filter(({ runs }) => runs.length > 0);
  if (reflowed.length === 0) return false;
  const reason = describeReflows(reflowed);
  process.stdout.write(`${JSON.stringify(
    needsRewrite(reflowed)
      ? { decision: "block", reason }
      : { hookSpecificOutput: { hookEventName, additionalContext: reason } },
  )}\n`);
  return true;
}
