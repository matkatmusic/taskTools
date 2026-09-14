// "did every change stay inside the task's owned files?" (pipeline.mmd). Derives the diff itself.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "./sourceRepoLock.ts";
import { buildDiscoveryManifest, buildOccurrencePath, buildOwnedOccurrencePaths, getOccurrencesDeepestFirst, parseOccurrencePath, type Occurrence } from "./occurrences.ts";
import { readTaskFile, resolveTaskFiles } from "../../shared/taskFiles.ts";
import { modifiableFiles } from "../../shared/prepareTasks.ts";
import { writableFiles } from "./writableFiles.ts";
import { isCompiledOutputOf } from "./compiledOutputPaths.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { logStepOutput } from "./logStepOutput.ts";

export type CheckTaskFileFenceInput = {
  projectRoot: string;
  worktreePath: string;
  taskNumber: number;
  runId: string;
  rootSourceBranch: string;
};

export type CheckTaskFileFenceOutput = { inside: boolean; violations: string[] };

function git(checkoutPath: string, ...args: string[]): string {
  return execFileSync("git", ["-C", checkoutPath, ...args], { encoding: "utf8" });
}

function declaredFiles(taskNumber: number, projectRoot: string): string[] {
  const { tasksPath } = resolveTaskFiles(projectRoot);
  const task = readTaskFile(tasksPath).find((candidate) => candidate.taskNumber === taskNumber);
  if (task === undefined)
    throw new Error(`task ${taskNumber} not found`);
  // const files = modifiableFiles(task);
  // Same pairing rule as pairedTestPath, plus the notes file: IMPLEMENT_TASK may create both.
  // const pairedTestPaths = files
  //   .filter((file) => !file.endsWith(".test.ts"))
  //   .map((file) => `tests/${basename(file).replace(/\.tsx?$/, "")}.test.ts`);
  // return [...new Set([...files, ...pairedTestPaths, `plans/implementation-notes-${taskNumber}.md`])];
  return writableFiles(task);
}

function readGitlinkOidAtHead(checkoutPath: string, pathInParent: string): string | null {
  try {
    return git(checkoutPath, "rev-parse", `HEAD:${pathInParent}`).trim();
  }
  catch {
    return null;
  }
}

// F10: deepest-first, so a parent gitlink is exempt only when its own child occurrence proves it.
export function computeExemptGitlinkPaths(
  worktreePath: string,
  projectRoot: string,
  rootSourceBranch: string,
  changedPathsByOccurrenceId: Map<string, string[]>,
  ownedPaths: Set<string>,
): Set<string> {
  const manifest = buildDiscoveryManifest(worktreePath, projectRoot, rootSourceBranch);
  const occurrencesById = new Map(manifest.repositoryManifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const deepestFirst = [...manifest.repositoryManifest.occurrences].sort((a, b) => b.depth - a.depth);

  const exempt = new Set<string>();
  for (const occurrence of deepestFirst) {
    if (occurrence.parentOccurrenceId === null || occurrence.pathInParent === null)
      continue;
    // Condition 4: the gitlink must be a direct parent/child relation in the discovered graph.
    const parent = occurrencesById.get(occurrence.parentOccurrenceId);
    if (parent === undefined)
      continue;

    const gitlinkPath = buildOccurrencePath(occurrence.parentOccurrenceId, occurrence.pathInParent);
    const childChangedPaths = changedPathsByOccurrenceId.get(occurrence.occurrenceId) ?? [];
    // Condition 1: the child occurrence contains at least one task change.
    const childHasAChange = childChangedPaths.length > 0;
    // Condition 2: every non-structural child change sits inside the owned occurrence paths.
    const nonStructuralChildChanges = childChangedPaths.filter((path) => !exempt.has(path));
    const everyNonStructuralChangeIsOwned = nonStructuralChildChanges.every((path) => ownedPaths.has(path));
    // Condition 3: the parent's recorded gitlink equals the child checkout's actual HEAD.
    const parentGitlinkOid = readGitlinkOidAtHead(parent.checkoutPath, occurrence.pathInParent);
    const childHeadOid = git(occurrence.checkoutPath, "rev-parse", "HEAD").trim();
    const gitlinkMatchesChildHead = parentGitlinkOid !== null && parentGitlinkOid === childHeadOid;

    if (childHasAChange && everyNonStructuralChangeIsOwned && gitlinkMatchesChildHead) {
      exempt.add(gitlinkPath);
    }
  }
  return exempt;
}

// A same-name .js is exempt when tsconfig.json confirms it's the compiled output of an owned .ts/.tsx file, not guessed.
export function computeExemptCompiledOutputPaths(
  occurrences: Occurrence[],
  allChangedPaths: string[],
  ownedPaths: Set<string>,
): Set<string> {
  const checkoutPathByOccurrenceId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence.checkoutPath]));
  const exempt = new Set<string>();
  for (const changedPath of allChangedPaths) {
    const { occurrenceId, relativePath } = parseOccurrencePath(changedPath);
    if (!relativePath.endsWith(".js"))
      continue;
    const stem = relativePath.slice(0, -".js".length);
    const checkoutPath = checkoutPathByOccurrenceId.get(occurrenceId);
    if (checkoutPath === undefined)
      continue;
    for (const sourceExtension of [".ts", ".tsx"]) {
      const sourceRelativePath = `${stem}${sourceExtension}`;
      if (!ownedPaths.has(buildOccurrencePath(occurrenceId, sourceRelativePath)))
        continue;
      if (isCompiledOutputOf(checkoutPath, sourceRelativePath, relativePath))
        exempt.add(changedPath);
    }
  }
  return exempt;
}

export function checkTaskFileFence(input: CheckTaskFileFenceInput): CheckTaskFileFenceOutput {
  requireAbsolutePath("projectRoot", input.projectRoot);
  requireAbsolutePath("worktreePath", input.worktreePath);
  const owner = buildLockOwner(input.runId, input.taskNumber);
  refreshOwnedSourceRepoLockOrThrow(input.projectRoot, owner);

  const declared = declaredFiles(input.taskNumber, input.projectRoot);
  // A task that declares "*" owns every path, so nothing can fall outside its fence.
  if (declared.includes("*"))
    return { inside: true, violations: [] };
  const occurrences = getOccurrencesDeepestFirst(input.worktreePath, input.projectRoot, input.rootSourceBranch);
  const ownedPaths = new Set(buildOwnedOccurrencePaths(declared, occurrences));

  const changedPathsByOccurrenceId = new Map<string, string[]>();
  const allChangedPaths: string[] = [];
  for (const occurrence of occurrences) {
    const rawLines = git(occurrence.checkoutPath, "diff", "--name-only", `${occurrence.baseRef}...HEAD`).split("\n");
    const taggedPaths: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const isBlank = line.length === 0;
      if (isBlank)
        continue;
      taggedPaths.push(buildOccurrencePath(occurrence.occurrenceId, line));
    }
    changedPathsByOccurrenceId.set(occurrence.occurrenceId, taggedPaths);
    allChangedPaths.push(...taggedPaths);
  }

  const exemptGitlinkPaths = computeExemptGitlinkPaths(input.worktreePath, input.projectRoot, input.rootSourceBranch, changedPathsByOccurrenceId, ownedPaths);
  const exemptCompiledOutputPaths = computeExemptCompiledOutputPaths(occurrences, allChangedPaths, ownedPaths);

  // ponytail: the pipeline's own resume bookkeeping file, exempt like in checkResumedWorktreeFence.
  const violations = allChangedPaths.filter((path) =>
    path !== "plans/checkpoint.json" && !ownedPaths.has(path) && !exemptGitlinkPaths.has(path) && !exemptCompiledOutputPaths.has(path));
  return { inside: violations.length === 0, violations };
}

const CHECK_TASK_FILE_FENCE_SOURCE = "scripts/tackle-tasks/checkTaskFileFence.ts:76: checkTaskFileFence";

if (process.argv[1]?.endsWith("checkTaskFileFence.ts")) {
  const payloadText = readFileSync(0, "utf8");
  const input = JSON.parse(payloadText) as CheckTaskFileFenceInput & { boxId?: string };
  const identity = { projectRoot: input.projectRoot, taskNumber: input.taskNumber, runId: input.runId };
  const boxId = input.boxId ?? "checkTaskFileFence";
  const command = `node ${process.argv[1]} <<'TTFENCE'\n${payloadText}\nTTFENCE`;

  try {
    const output = checkTaskFileFence(input);
    const commandOutput = `${JSON.stringify(output)}\n`;
    logStepOutput(identity, { boxId, source: CHECK_TASK_FILE_FENCE_SOURCE, input, command, commandOutput, output });
    process.stdout.write(commandOutput);
  }
  catch (error) {
    const message = String((error as Error)?.message ?? error);
    logStepOutput(identity, { boxId, source: CHECK_TASK_FILE_FENCE_SOURCE, input, command, commandOutput: message, output: { error: message } });
    throw error;
  }
}
