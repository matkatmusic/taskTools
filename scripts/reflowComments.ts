// clang-format for `//` prose: rejoin wrapped comment runs onto one line, leaving commented-out code untouched.
import { readFileSync, writeFileSync } from "node:fs";

const COMMENT = /^(\s*)\/\/ ?(.*)$/;
const DIRECTIVE = /^(eslint-|@ts-|prettier-|biome-|ponytail:|#region|#endregion|c8 |istanbul |v8 )/;
const WORD_LIMIT = 20;

export type Reflow = { start: number; end: number; line: number; words: number };

function looksLikeCode(body: string): boolean {
  return (
    /[;{}]$|=>$|\)$/.test(body) ||
    /^[)}\]]/.test(body) ||
    /^(const|let|var|function|if|else|for|while|do|return|import|export|class|await|try|catch|switch|case|throw|new|type|interface)\b/.test(body) ||
    /^[\w.$]+\s*[:=][^=]/.test(body) ||
    /^[\w.$]+\(/.test(body)
  );
}

// Two spaces after a sentence-ending line, one space otherwise.
function joinBodies(bodies: string[]): string {
  return bodies.reduce((acc, body) => acc + (/[.!?]["')\]]?$/.test(acc) ? "  " : " ") + body);
}

function runIsProse(bodies: string[]): boolean {
  return (
    bodies.length > 1 &&
    !DIRECTIVE.test(bodies[0]) &&
    bodies.every((body) => body.length > 0 && !looksLikeCode(body))
  );
}

export function reflowSource(source: string): { text: string; runs: Reflow[] } {
  const lines = source.split("\n");
  const out: string[] = [];
  const runs: Reflow[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i].match(COMMENT);
    if (!head) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const [, indent] = head;
    let end = i;
    const bodies: string[] = [head[2].trim()];
    while (end + 1 < lines.length) {
      const next = lines[end + 1].match(COMMENT);
      if (!next || next[1] !== indent) break;
      bodies.push(next[2].trim());
      end += 1;
    }
    if (runIsProse(bodies)) {
      const text = joinBodies(bodies);
      runs.push({
        start: i + 1,
        end: end + 1,
        line: out.length + 1,
        words: text.split(/\s+/).length,
      });
      out.push(`${indent}// ${text}`);
    } else {
      out.push(...lines.slice(i, end + 1));
    }
    i = end + 1;
  }
  return { text: out.join("\n"), runs };
}

export function describeReflows(path: string, runs: Reflow[]): string[] {
  return runs.flatMap((run) => [
    `${path}: the comment on lines [${run.start}-${run.end}] was rewritten as a single line.`,
    run.words < WORD_LIMIT
      ? `do nothing with this stop hook feedback for line '${run.line}'`
      : `The comment on line [${run.line}]  needs to be truncated to be less than ${WORD_LIMIT} words long.  rewrite the comment.`,
  ]);
}

export function reflowFile(path: string): Reflow[] {
  const source = readFileSync(path, "utf8");
  const { text, runs } = reflowSource(source);
  if (runs.length > 0 && text !== source) writeFileSync(path, text);
  return runs;
}
