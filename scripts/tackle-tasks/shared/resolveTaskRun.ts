// Replaces bootstrap's "prepare" mode front-end before "is task number valid?". Mutates nothing: no worktree, no tasks.json write.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { generateRunId } from "../../shared/prepareTasks.ts";
import { currentBranchName } from "../../shared/repositoryBranches.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type ResolveTaskRunOutput = {
  taskNumbers: number[];
  fast: boolean;
  projectRoot: string;
  sourceBranch: string;
  runId: string;
};

const TASK_NUMBER_TOKEN = /^-?\d+$/;
const FAST_TOKEN = "fast";

// M2: accepts a delimiter-separated list of positive safe integers, optionally wrapped in one matching bracket pair.
export function parseTaskNumberArgument(args: string): number[] {
  const trimmed = args.trim();
  const hasLeadingBracket = trimmed.startsWith("[");
  const closingBracket = trimmed.indexOf("]");
  if (hasLeadingBracket !== (closingBracket !== -1)) {
    throw new Error(`unmatched bracket in "${trimmed}"`);
  }
  const body = hasLeadingBracket ? trimmed.slice(1, closingBracket) : trimmed;
  const tokens = body.trim().split(/[\s,]+/).filter((t) => t.length > 0);
  if (tokens.length === 0)
    throw new Error("no task numbers given");
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const token of tokens) {
    const number = Number(token);
    const isTaskNumberToken = TASK_NUMBER_TOKEN.test(token);
    const isSafeInteger = Number.isSafeInteger(number);
    const isPositive = number > 0;
    if (!isTaskNumberToken || !isSafeInteger || !isPositive) {
      throw new Error(`invalid task number "${token}"`);
    }
    if (!seen.has(number)) {
      seen.add(number);
      numbers.push(number);
    }
  }
  return numbers;
}

// The fast pipeline is picked by the word "fast" after the bracketed task list.
export function parseFastArgument(args: string): boolean {
  const closingBracket = args.indexOf("]");
  if (closingBracket === -1)
    return false;
  const rest = args.slice(closingBracket + 1).trim();
  if (rest === "")
    return false;
  return rest.split(/\s+/).includes(FAST_TOKEN);
}

// The custom diagram folder is picked by a "folder:<dir>" word after the bracketed task list.
export function parseFolderArgument(args: string): string {
  const closingBracket = args.indexOf("]");
  if (closingBracket === -1)
    return "";
  const rest = args.slice(closingBracket + 1).trim();
  if (rest === "")
    return "";
  for (const token of rest.split(/\s+/)) {
    if (token.startsWith("folder:")) {
      return token.slice("folder:".length);
    }
  }
  return "";
}

// The block name to start the workflow walk from, if the caller named one after the task list.
export function parseStartingBlockArgument(args: string): string {
  const closingBracket = args.indexOf("]");
  if (closingBracket === -1)
    return "";
  const rest = args.slice(closingBracket + 1).trim();
  if (rest === "")
    return "";
  return rest.split(/\s+/).filter((token) => token !== FAST_TOKEN && !token.startsWith("folder:"))[0] ?? "";
}

export function resolveTaskRun(args: string, projectRoot: string): ResolveTaskRunOutput {
  requireAbsolutePath("projectRoot", projectRoot);
  const taskNumbers = parseTaskNumberArgument(args);
  return {
    taskNumbers,
    fast: parseFastArgument(args),
    projectRoot,
    sourceBranch: currentBranchName(projectRoot),
    runId: generateRunId(),
  };
}

// The invoking shell may sit in any subdirectory of the repository, and every downstream consumer — sourceRepoLock's <projectRoot>/.git path above all — needs the repository top level, never that subdirectory. This is the one place a working directory is read, and it is normalized here.
export function repositoryTopLevel(startDirectory: string): string {
  const topLevel = execFileSync("git", ["-C", startDirectory, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  if (topLevel === "")
    throw new Error(`no git repository at ${startDirectory}`);
  return topLevel;
}

if (process.argv[1]?.endsWith("resolveTaskRun.ts")) {
  const input = JSON.parse(readFileSync(0, "utf8")) as { args: string; projectRoot?: string };
  try {
    const output = resolveTaskRun(input.args, input.projectRoot ?? repositoryTopLevel(process.cwd()));
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
  catch (error) {
    process.stderr.write(`resolveTaskRun: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
