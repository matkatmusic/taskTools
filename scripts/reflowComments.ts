// clang-format for `//` prose: rejoin wrapped comment runs onto one line, leaving commented-out code untouched.
import { readFileSync, writeFileSync } from "node:fs";
import { applyQuota } from "./reflowQuota.ts";
import {
  BODY_LOOKS_LIKE_CODE,
  BODY_LOOKS_LIKE_PROSE,
  CONTINUES_COMMENT_RUN,
  REFLOW_EMITTED,
  REFLOW_NOT_EMITTED,
  REWRITE_NEEDED,
  REWRITE_NOT_NEEDED,
  RUN_IS_NOT_PROSE,
  RUN_IS_PROSE,
  STARTS_NEW_COMMENT_RUN,
} from "./resultCodes.ts";

const COMMENT = /^(\s*)(\/\/|%%)(?!\/) ?(.*)$/; // `%%` is mermaid's line comment; `///` opts out
const MACHINE_DIRECTIVE = /^(eslint-|@ts-|prettier-|biome-|#region|#endregion|c8 |istanbul |v8 )/;
const PARAGRAPH_MARK = /^ponytail:/; // joined like prose, but exempt from the word cap
const DIVIDER = /^[-=*_#]{3,}/; // `---- section ----`: hand-formatted, passed through verbatim
// `skipIf` guards JSDoc, whose `*`-prefixed continuation lines are a layout the tool must not touch.
const BLOCK_KINDS = [
  {
    open: /^(\s*)\/\*(?!\*)/, openTag: "/*", closeTag: "*/",
    stripOpen: /^\s*\/\*+/, stripClose: /\*\/\s*$/, skipIf: /^\*/,
  },
  {
    open: /^(\s*)<!--/, openTag: "<!--", closeTag: "-->",
    stripOpen: /^\s*<!--/, stripClose: /-->\s*$/, skipIf: undefined,
  },
];
const KEYWORD = /^(const|let|var|function|if|else|for|while|do|return|import|export|class|await|try|catch|switch|case|throw|new|type|interface)(?=[\s;({]|$)/;
const WORD_LIMIT = 20;

export type Reflow = {
  start: number; end: number; line: number; words: number; joined: boolean; capped: boolean;
};

// Trailing `;` and `)` are left out: wrapped prose ends lines that way too.
function looksLikeCode(body: string): number {
  const isCode = (
    /[{}]$|=>$/.test(body) ||
    /^[)}\]]/.test(body) ||
    /^<[/!a-zA-Z]/.test(body) || // commented-out markup

    (KEYWORD.test(body) && (/^\w+\s*\(/.test(body) || /[;{,:]$/.test(body))) ||
    /^[\w.$]+\s*[:=].*[,;:{]$/.test(body) ||
    /^[\w.$]+\(.*[;,){]$/.test(body)
  );
  return isCode ? BODY_LOOKS_LIKE_CODE : BODY_LOOKS_LIKE_PROSE;
}

// A directive begins a new comment instead of poisoning the run above it.
const startsNewRun = (body: string): number =>
  (DIVIDER.test(body) || MACHINE_DIRECTIVE.test(body) || PARAGRAPH_MARK.test(body))
    ? STARTS_NEW_COMMENT_RUN
    : CONTINUES_COMMENT_RUN;

// Two spaces after a sentence-ending line, one space otherwise.
function joinBodies(bodies: string[]): string {
  return bodies.reduce((acc, body) => acc + (/[.!?]["')\]]?$/.test(acc) ? "  " : " ") + body);
}

function runIsProse(bodies: string[]): number {
  const isProse = (
    bodies.length > 0 &&
    !MACHINE_DIRECTIVE.test(bodies[0]) &&
    bodies.every((body) => looksLikeCode(body) === BODY_LOOKS_LIKE_PROSE)
  );
  return isProse ? RUN_IS_PROSE : RUN_IS_NOT_PROSE;
}

// Block prose: continuation lines carry no marker, so the block is taken whole.
function reflowBlock(lines: string[], start: number, outLen: number) {
  const kind = BLOCK_KINDS.find((candidate) => candidate.open.test(lines[start]));
  if (!kind) return null;
  const indent = lines[start].match(kind.open)![1];
  let end = start;
  while (end < lines.length && !lines[end].includes(kind.closeTag)) end += 1;
  if (end >= lines.length) return null;

  const raw = lines.slice(start, end + 1);
  const bodies = raw.map((line, n) => {
    const stripped = (n === 0 ? line.replace(kind.stripOpen, "") : line);
    return (n === raw.length - 1 ? stripped.replace(kind.stripClose, "") : stripped).trim();
  });
  if (bodies.some((body) => body !== "" && looksLikeCode(body) === BODY_LOOKS_LIKE_CODE)) return null;
  if (kind.skipIf && bodies.some((body) => kind.skipIf!.test(body))) return null;

  const paragraphs: { bodies: string[]; start: number; end: number }[] = [];
  bodies.forEach((body, n) => {
    if (body === "") return;
    const last = paragraphs.at(-1);
    if (last && bodies[n - 1] !== "") last.bodies.push(body), (last.end = start + n + 1);
    else paragraphs.push({ bodies: [body], start: start + n + 1, end: start + n + 1 });
  });
  if (paragraphs.length === 0) return null;

  // Delimiters get their own lines; body sits two spaces in from the opener.
  const out: string[] = [`${indent}${kind.openTag}`];
  const placed = paragraphs.map((paragraph) => {
    if (out.length > 1) out.push("");
    out.push(`${indent}  ${joinBodies(paragraph.bodies)}`);
    return { paragraph, line: outLen + out.length };
  });
  out.push(`${indent}${kind.closeTag}`);

  const changed = out.length !== raw.length || out.some((line, n) => line !== raw[n]);
  const runs = placed.flatMap(({ paragraph, line }) => {
    const words = joinBodies(paragraph.bodies).split(/\s+/).length;
    if (!changed && words < WORD_LIMIT) return [];
    return [{ start: paragraph.start, end: paragraph.end, line, words, joined: changed, capped: true }];
  });
  return { end, out, runs };
}

export function reflowSource(source: string): { text: string; runs: Reflow[] } {
  const lines = source.split("\n");
  const out: string[] = [];
  const runs: Reflow[] = [];
  let i = 0;
  while (i < lines.length) {
    const block = reflowBlock(lines, i, out.length);
    if (block) {
      out.push(...block.out);
      runs.push(...block.runs);
      i = block.end + 1;
      continue;
    }
    const head = lines[i].match(COMMENT);
    // A bare `//` or a `---- section ----` rule separates comments, it never starts one.
    if (!head || head[3].trim() === "" || DIVIDER.test(head[3].trim())) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const [, indent, marker] = head;
    let end = i;
    const bodies: string[] = [head[3].trim()];
    while (end + 1 < lines.length) {
      const next = lines[end + 1].match(COMMENT);
      if (!next || next[1] !== indent || next[2] !== marker || startsNewRun(next[3].trim()) === STARTS_NEW_COMMENT_RUN) break;
      if (next[3].trim() !== "") bodies.push(next[3].trim());
      end += 1;
    }
    if (runIsProse(bodies) === RUN_IS_PROSE) {
      const text = joinBodies(bodies);
      const words = text.split(/\s+/).length;
      const joined = bodies.length > 1;
      const capped = !PARAGRAPH_MARK.test(bodies[0]);
      // An already-flat comment is only worth reporting when it busts the cap.
      if (joined || (capped && words >= WORD_LIMIT)) {
        runs.push({ start: i + 1, end: end + 1, line: out.length + 1, words, joined, capped });
      }
      out.push(`${indent}${marker} ${text}`);
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

export const needsRewrite = (files: FileReflow[]): number =>
  files.some((f) => overCapLines(f).lines.length > 0) ? REWRITE_NEEDED : REWRITE_NOT_NEEDED;

// A JSON string, so the receiving agent parses instead of reasoning about prose.
export function describeReflows(
  files: FileReflow[],
  overCap = files.map(overCapLines).filter(({ lines }) => lines.length > 0),
): string {
  const rewritten = files
    .map(({ path, runs }) => ({ file: path, lines: runs.filter((run) => run.joined).map((run) => run.line) }))
    .filter(({ lines }) => lines.length > 0);
  return JSON.stringify({
    ...(rewritten.length > 0 && {
      information: "the following lines were rewritten by a hook after your edit",
      rewritten,
    }),
    ...(overCap.length > 0 && {
      instruction: `Spawn a sonnet-5 subagent to rewrite only 1-2 of the comments below to under ${WORD_LIMIT} words, keeping each on one line. Return to your primary task after finishing the comment rewrites.  The hook will track when any flagged comments pass the word-length restriction and stop blocking you.`,
      files: overCap.map(({ path, lines }) => ({ path, lines, show: showCommand(path, lines) })),
    }),
  });
}

export function reflowFile(path: string): Reflow[] {
  // Markdown prose is not comments; reflowing it mangles plans and docs.
  if (path.endsWith(".md")) return [];
  const source = readFileSync(path, "utf8");
  const { text, runs } = reflowSource(source);
  if (runs.length > 0 && text !== source) writeFileSync(path, text);
  return runs;
}

// Blocks on over-cap comments; with a sessionId the quota silences already-seen debt after one fix.
export function emitReflows(hookEventName: string, files: FileReflow[], sessionId?: string): number {
  const reflowed = files.filter(({ runs }) => runs.length > 0);
  if (reflowed.length === 0) return REFLOW_NOT_EMITTED;
  let overCap = reflowed.map(overCapLines).filter(({ lines }) => lines.length > 0);
  if (sessionId) overCap = applyQuota(sessionId, overCap);
  const joined = reflowed.some(({ runs }) => runs.some((run) => run.joined));
  if (overCap.length === 0) {
    if (!joined) return REFLOW_NOT_EMITTED;
  }
  const reason = describeReflows(reflowed, overCap);
  process.stdout.write(`${JSON.stringify(
    overCap.length > 0
      ? { decision: "block", reason }
      : { hookSpecificOutput: { hookEventName, additionalContext: reason } },
  )}\n`);
  return REFLOW_EMITTED;
}
