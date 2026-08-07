# Task 112 Plan: stop archiving tasks against commits that don't contain their code

## Revision note

This is a rewrite after two rejections from review. The reviewer's verdict
(verbatim, both PROBLEMS and FIXES) is the spec for this revision; every
edit below traces to one of its bullets. The previous plan's structural
mistake was keeping `archivePublishedTasks(...)` inside `mergePipeline.ts`
(the subprocess `runMergePhase.ts` spawns) and merely reordering it within
that subprocess. That can never be the real success gate: the subprocess's
own printed JSON is not final until `runMergePhase.ts`'s `judgeMergeRun`
(and, on base drift, `coordinateMergeRetry`) have read its exit code and
stdout and decided `merged` vs `blocked` — and only `runMergePhase.ts` knows
that outcome. So this revision moves the archival *call* itself out of
`mergePipeline.ts` entirely and into `runMergePhase.ts`, run only after the
final verdict is known. This also means `scripts/runMergePhase.ts`, listed
as "no edit" in the previous plan, is now edited — the reviewer's ordering
fix requires it.

## Root cause, mapped to the reviewer's three PROBLEMS

**Problem 1 — archival runs before the final verdict, and "last in the
callback" isn't "after `runFinalization`".** In `scripts/mergePipeline.ts`,
`archivePublishedTasks(...)` is called and writes `tasks.json` /
`completedTasks.json` to disk from *inside* the callback passed to
`runFinalization(token, digest, async () => {...})`, at the point currently
reading (verbatim, lines 232-245 as read from the file):
```
const rawOutcomes: RawTaskRepoOutcome[] = sortedGroups.flatMap((group) => group.tasks.flatMap((task) => logicalGroups.map((logicalGroup) => ({
    taskNumber: task.number, repo: { repoName: logicalGroup.logicalId, status: "published" as const, commitHash: consolidations.get(logicalGroup.logicalId)!.preparedIntegrationOid },
}))));
const mergeResults = summarizeTaskMergeResults(rawOutcomes);
archivePublishedTasks(sortedGroups.flatMap((group) => group.tasks.map((task) => task.number)), mergeResults, input.repo);
```
`mergePipeline.ts` runs as a *subprocess* of `runMergePhase.ts` (spawned via
`runScript(command)` in `runAsCli()`, where `command` invokes
`resolveMergeScriptPath()` with `--run`). Whatever this subprocess prints to
stdout only becomes a verdict after `judgeMergeRun` parses it back in the
parent process — and `judgeMergeRun` can still classify a clean exit with
empty `publicationTargets` as `blocked`. No amount of reordering statements
*inside* the subprocess's own callback fixes this, because the subprocess
has already written to disk and exited before the parent ever computes
`blocked` vs `merged`. The fix has to move the write itself across that
process boundary, to after the parent's verdict is final.

**Problem 2 — `archivePublishedTasks` silently drops invalid candidates and
its result is unchecked.** In `scripts/taskArchival.ts`, the current loop
(lines 57-65) does `if (index === -1) continue;` and computes
`commitHashes` with no length check, so a "published" task with no
`tasks.json` entry, no declared files, or zero surviving commit hashes is
just skipped — `archived` silently comes back short, and nothing in
`mergePipeline.ts` ever looks at it. The fix makes this throw before
mutating anything, so the caller can't miss it.

**Problem 3 — path ownership treats a submodule's own checkout path as
"inside" the submodule.** The helper design in the previous plan used:
```
if (path !== relativePath && !path.startsWith(`${relativePath}/`)) continue;
```
which explicitly *allows* `path === relativePath` to pass — so declaring a
task's file as exactly `"sub"` (a submodule's checkout path) would resolve
`"sub"` as owned by the submodule occurrence with an empty
`repoRelativePath`. But `"sub"` as a path *in the parent's tree* is the
gitlink entry, which lives in the parent repository, not inside the
submodule's own git history. The fix requires a *strict* directory prefix
(`path.startsWith(`${relativePath}/`)`), so only paths nested under a
checkout belong to that occurrence; an exact match falls through to the
next-shallower owner (ultimately the root, whose `relativePath` is always
`""` and therefore always strictly-or-trivially matches).

## Files requiring no edit (with reason)

- **`scripts/mergeTaskWorktrees.ts`** — contains no archival logic and never
  calls `archivePublishedTasks` or `closeTasks`; it only merges worktrees and
  dispatches to `runMergePipeline`. Nothing here participates in any of the
  three problems.
- **`scripts/closeTasks.ts`** — the separate, human-driven manual closure
  path used by the `taskTools:close-tasks` skill. Verified by direct
  inspection: `closeTasks.ts` never imports or calls `archivePublishedTasks`,
  `summarizeTaskMergeResults`, or anything from `taskArchival.ts` — it has
  its own independent read/splice/write logic and its own `closureNote`
  field that `archivePublishedTasks` doesn't write. Out of scope.

`scripts/runMergePhase.ts` is **no longer** in this list — see "Exact edits"
below; the reviewer's ordering fix requires archival to run there.

## Exact edits

### 1. `scripts/taskArchival.ts`

**Edit 1 — drop the `TaskRecord` import gap, and pull in `readFileSync` for
the rollback snapshot.**

Current (lines 1-3):
```
// Archives fully-published tasks from an explicit list; task 31's approvalGate.ts already gates this, so no re-prompt.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
```
Becomes:
```
// Archives fully-published tasks from an explicit list; task 31's approvalGate.ts already gates this, so no re-prompt.
import { readFileSync, writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
```

**Edit 2 — add the `ArchiveRequest` type**, the payload shape
`mergePipeline.ts` will emit and `runMergePhase.ts` will consume. Insert
right after the existing `RawTaskRepoOutcome` type (current lines 19-22):
```
export type RawTaskRepoOutcome = {
    taskNumber: number;
    repo: RepoPublishResult;
};
```
Becomes:
```
export type RawTaskRepoOutcome = {
    taskNumber: number;
    repo: RepoPublishResult;
};

export type ArchiveRequest = { publishedTaskNumbers: number[]; mergeResults: TaskMergeResult[] };
```

**Edit 3 — replace the whole `archivePublishedTasks` function** (current
lines 38-71, verbatim) with a preflight-then-transactional-write version.
Every candidate (a task named in `publishedTaskNumbers` whose merge result
is `fullyPublished`) must pass three checks — present in `tasks.json`, has a
non-empty `files` array, has at least one surviving commit hash — *before*
either file is touched; the first failing candidate throws and nothing is
written. Once every candidate passes, both files' original contents are
snapshotted and both final JSON strings are serialized *before* either
`writeFileSync` is attempted; if the second write throws, both files are
restored from that snapshot before the error is rethrown.

Current (verbatim):
```
export function archivePublishedTasks(
    publishedTaskNumbers: number[],
    mergeResults: TaskMergeResult[],
    projectRoot: string = process.cwd(),
): { archived: number[]; leftOpen: number[] } {
    const resultsByTask = new Map(mergeResults.map((result) => [result.taskNumber, result]));
    const considered = new Set<number>([...publishedTaskNumbers, ...mergeResults.map((result) => result.taskNumber)]);

    const archived: number[] = [];
    for (const taskNumber of new Set(publishedTaskNumbers)) {
        if (resultsByTask.get(taskNumber)?.fullyPublished) archived.push(taskNumber);
    }
    const leftOpen = [...considered].filter((taskNumber) => !archived.includes(taskNumber));

    if (archived.length > 0) {
        const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
        const tasks = readTaskFile(tasksPath);
        const completedTasks = readTaskFile(completedTasksPath);
        const completionDate = new Date().toISOString().slice(0, 10);
        for (const taskNumber of archived) {
            const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
            if (index === -1) continue;
            const [task] = tasks.splice(index, 1);
            const commitHashes = (resultsByTask.get(taskNumber)?.repos ?? [])
                .filter((repo) => repo.status === "published" && repo.commitHash)
                .map((repo) => repo.commitHash as string);
            completedTasks.push({ ...task, completionDate, commitHashes });
        }
        writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
        writeFileSync(completedTasksPath, JSON.stringify(completedTasks, null, 2) + "\n");
    }

    return { archived, leftOpen };
}
```
Becomes:
```
export function archivePublishedTasks(
    publishedTaskNumbers: number[],
    mergeResults: TaskMergeResult[],
    projectRoot: string = process.cwd(),
    writeFile: (path: string, data: string) => void = writeFileSync,
): { archived: number[]; leftOpen: number[] } {
    const resultsByTask = new Map(mergeResults.map((result) => [result.taskNumber, result]));
    const considered = new Set<number>([...publishedTaskNumbers, ...mergeResults.map((result) => result.taskNumber)]);

    const candidates: number[] = [];
    for (const taskNumber of new Set(publishedTaskNumbers)) {
        if (resultsByTask.get(taskNumber)?.fullyPublished) candidates.push(taskNumber);
    }

    let archived: number[] = [];
    if (candidates.length > 0) {
        const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
        const originalTasksRaw = readFileSync(tasksPath, "utf8");
        const originalCompletedRaw = readFileSync(completedTasksPath, "utf8");
        const tasks = readTaskFile(tasksPath);
        const completedTasks = readTaskFile(completedTasksPath);
        const completionDate = new Date().toISOString().slice(0, 10);

        // Preflight every candidate before mutating either file: one invalid candidate blocks the whole batch, not just itself.
        const toArchive: { index: number; task: TaskRecord; commitHashes: string[] }[] = [];
        for (const taskNumber of candidates) {
            const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
            if (index === -1) throw new Error(`archivePublishedTasks: task ${taskNumber} is fully published but missing from tasks.json`);
            const declaredFiles = (tasks[index].files as string[] | undefined) ?? [];
            if (declaredFiles.length === 0) throw new Error(`archivePublishedTasks: task ${taskNumber} declares no files; refusing to archive`);
            const commitHashes = resultsByTask.get(taskNumber)!.repos
                .filter((repo) => repo.status === "published" && repo.commitHash)
                .map((repo) => repo.commitHash as string);
            if (commitHashes.length === 0) throw new Error(`archivePublishedTasks: task ${taskNumber} has no usable commit hash; refusing to archive`);
            toArchive.push({ index, task: tasks[index], commitHashes });
        }

        for (const { index } of [...toArchive].sort((a, b) => b.index - a.index)) tasks.splice(index, 1);
        for (const { task, commitHashes } of toArchive) completedTasks.push({ ...task, completionDate, commitHashes });
        archived = toArchive.map(({ task }) => task.taskNumber);

        // ponytail: unreachable given the loop above always pushes one entry per candidate; kept as the explicit post-write invariant the reviewer asked for, so a future change to the preflight loop that reintroduces a silent skip fails loudly here instead of writing a partial archive.
        const stillOpen = candidates.filter((taskNumber) => !archived.includes(taskNumber));
        if (stillOpen.length > 0) throw new Error(`archivePublishedTasks: candidates left unarchived: ${stillOpen.join(", ")}`);

        // Serialize both final versions before touching disk, so a mid-write failure has a known-good pair to restore.
        const serializedTasks = JSON.stringify(tasks, null, 2) + "\n";
        const serializedCompleted = JSON.stringify(completedTasks, null, 2) + "\n";
        try {
            writeFile(tasksPath, serializedTasks);
            writeFile(completedTasksPath, serializedCompleted);
        } catch (writeError) {
            const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
            try {
                writeFile(tasksPath, originalTasksRaw);
                writeFile(completedTasksPath, originalCompletedRaw);
            } catch (rollbackError) {
                const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                throw new Error(`archivePublishedTasks: write failed (${writeMessage}) and rollback also failed (${rollbackMessage}); tasks.json/completedTasks.json may be inconsistent`);
            }
            throw new Error(`archivePublishedTasks: write failed and was rolled back to the original files: ${writeMessage}`);
        }
    }

    const leftOpen = [...considered].filter((taskNumber) => !archived.includes(taskNumber));
    return { archived, leftOpen };
}
```

Note for the implementer: a task named in `publishedTaskNumbers` whose merge
result is *not* `fullyPublished` (e.g. a conflicted or rolled-back repo) is
never added to `candidates` and so never goes through the preflight — it
just lands in `leftOpen`, exactly as before. The throw-before-any-write
preflight still runs before either file's contents are serialized for
writing. What's new this round: the two `writeFileSync` calls that follow
are now wrapped in a rollback. Both original file contents are captured
*raw* (via `readFileSync`, not re-derived from the parsed/mutated arrays,
so the restore is byte-identical to what was on disk) and both final JSON
strings are serialized *before* either write is attempted. If the second
write throws, the handler restores both files from that pre-write snapshot
through the same injectable `writeFile` dependency, then rethrows an error
naming both the original write failure and any rollback failure. This
closes the reviewer's Problem 1: a `blocked` verdict downstream (via
`archiveIfMerged`'s `catch`, see `scripts/runMergePhase.ts` below) now
corresponds to `tasks.json` and `completedTasks.json` being byte-identical
to their pre-call state, never a half-written pair.

### 2. `scripts/mergePipeline.ts`

**Edit 1 — export the shared type aliases** so tests can build real
`Coordinate`/`LogicalGroup`/`ConsolidationOutcome` values.

Current (lines 27-30):
```
export type PublicationTargetSummary = { repositoryPath: string; recordedBaseOid: string; targetOid: string };
type Coordinate = { repoRoot: string; relativePath: string };
type LogicalGroup = { logicalId: string; occurrenceIds: string[]; canonicalOccurrenceId: string };
type ConsolidationOutcome = { preparedIntegrationOid: string; canonicalRepoRoot: string; canonicalRefName: string; recordedBaseOid: string; integrationRef: string };
```
Becomes:
```
export type PublicationTargetSummary = { repositoryPath: string; recordedBaseOid: string; targetOid: string };
export type Coordinate = { repoRoot: string; relativePath: string };
export type LogicalGroup = { logicalId: string; occurrenceIds: string[]; canonicalOccurrenceId: string };
export type ConsolidationOutcome = { preparedIntegrationOid: string; canonicalRepoRoot: string; canonicalRefName: string; recordedBaseOid: string; integrationRef: string };
```

**Edit 2 — stop importing `archivePublishedTasks`; import the
`ArchiveRequest` type instead.**

Current (line 18):
```
import { summarizeTaskMergeResults, archivePublishedTasks, type RawTaskRepoOutcome } from "./taskArchival.ts";
```
Becomes:
```
import { summarizeTaskMergeResults, type RawTaskRepoOutcome, type ArchiveRequest } from "./taskArchival.ts";
```

**Edit 3 — export `buildCoordinates`.**

Current (line 44):
```
function buildCoordinates(repo: string, manifest: RepositoryManifest): Map<string, Coordinate> {
```
Becomes:
```
export function buildCoordinates(repo: string, manifest: RepositoryManifest): Map<string, Coordinate> {
```

**Edit 4 — export `buildLogicalGroups`.**

Current (line 60):
```
function buildLogicalGroups(manifest: RepositoryManifest): LogicalGroup[] {
```
Becomes:
```
export function buildLogicalGroups(manifest: RepositoryManifest): LogicalGroup[] {
```

**Edit 5 — export `topoOrderLogicalGroups`.**

Current (lines 69-70):
```
// Post-order DFS over occurrence childOccurrenceIds mapped through their owning logical group: children before parents.
function topoOrderLogicalGroups(groups: LogicalGroup[], manifest: RepositoryManifest): LogicalGroup[] {
```
Becomes:
```
// Post-order DFS over occurrence childOccurrenceIds mapped through their owning logical group: children before parents.
export function topoOrderLogicalGroups(groups: LogicalGroup[], manifest: RepositoryManifest): LogicalGroup[] {
```

**Edit 6 — add the fixed path-ownership and validation helpers**, inserted
right after `buildCoordinates`'s closing brace and before `identityKey`.

Current (lines 51-55, verbatim):
```
        coordinates.set(occurrence.occurrenceId, { repoRoot, relativePath: relativePath === "." ? "" : relativePath });
    }
    return coordinates;
}
function identityKey(occurrence: RepositoryOccurrence): string {
```
Becomes:
```
        coordinates.set(occurrence.occurrenceId, { repoRoot, relativePath: relativePath === "." ? "" : relativePath });
    }
    return coordinates;
}
// Deepest checkout that's a strict prefix of `path` owns it; an exact checkout match belongs to the parent.
function ownerLogicalIdForPath(path: string, manifest: RepositoryManifest, coordinates: Map<string, Coordinate>, logicalGroups: LogicalGroup[]): { logicalId: string; repoRelativePath: string } {
    let best: { occurrenceId: string; relativePath: string } | null = null;
    for (const occurrence of manifest.occurrences) {
        const relativePath = coordinates.get(occurrence.occurrenceId)!.relativePath;
        if (relativePath !== "" && !path.startsWith(`${relativePath}/`)) continue;
        if (!best || relativePath.length > best.relativePath.length) best = { occurrenceId: occurrence.occurrenceId, relativePath };
    }
    const repoRelativePath = best!.relativePath === "" ? path : path.slice(best!.relativePath.length + 1);
    return { logicalId: occurrenceToLogicalId(logicalGroups, best!.occurrenceId), repoRelativePath };
}
export function taskFilesByLogicalId(files: string[], manifest: RepositoryManifest, coordinates: Map<string, Coordinate>, logicalGroups: LogicalGroup[]): Set<string> {
    return new Set(files.map((path) => ownerLogicalIdForPath(path, manifest, coordinates, logicalGroups).logicalId));
}
function pathExistsInTree(repoRoot: string, commitHash: string, path: string): boolean {
    try {
        execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${commitHash}:${path}`], { stdio: ["ignore", "ignore", "ignore"] });
        return true;
    } catch {
        return false;
    }
}
function consolidationChangedFromBase(repoRoot: string, recordedBaseOid: string, preparedIntegrationOid: string): boolean {
    return git(repoRoot, "rev-parse", `${recordedBaseOid}^{tree}`).trim() !== git(repoRoot, "rev-parse", `${preparedIntegrationOid}^{tree}`).trim();
}
// Returns an abortReason for the first failing task/repository pair, or null if every declared file is verified.
export function findTaskArchivalValidationFailure(
    tasks: { number: number; files: string[] }[],
    manifest: RepositoryManifest,
    coordinates: Map<string, Coordinate>,
    logicalGroups: LogicalGroup[],
    consolidations: Map<string, ConsolidationOutcome>,
): string | null {
    for (const task of tasks) {
        if (task.files.length === 0) return `task ${task.number} declares no files; refusing to archive without a way to verify its code landed`;
        const pathsByLogicalId = new Map<string, string[]>();
        for (const path of task.files) {
            const owned = ownerLogicalIdForPath(path, manifest, coordinates, logicalGroups);
            const paths = pathsByLogicalId.get(owned.logicalId) ?? [];
            paths.push(owned.repoRelativePath);
            pathsByLogicalId.set(owned.logicalId, paths);
        }
        for (const [logicalId, repoRelativePaths] of pathsByLogicalId) {
            const consolidation = consolidations.get(logicalId);
            if (!consolidation || !consolidation.preparedIntegrationOid) return `task ${task.number}: no integration commit recorded for repository "${logicalId}"`;
            if (!consolidationChangedFromBase(consolidation.canonicalRepoRoot, consolidation.recordedBaseOid, consolidation.preparedIntegrationOid)) {
                return `task ${task.number}: consolidation for repository "${logicalId}" produced no changes from its recorded base (empty commit ${consolidation.preparedIntegrationOid})`;
            }
            for (const repoRelativePath of repoRelativePaths) {
                if (!pathExistsInTree(consolidation.canonicalRepoRoot, consolidation.preparedIntegrationOid, repoRelativePath)) {
                    return `task ${task.number}: declared file "${repoRelativePath}" is missing from commit ${consolidation.preparedIntegrationOid} in repository "${logicalId}"`;
                }
            }
        }
    }
    return null;
}
function identityKey(occurrence: RepositoryOccurrence): string {
```

This is the reviewer's required ownership fix: `ownerLogicalIdForPath` no
longer has a `path !== relativePath` escape hatch, and no longer needs a
separate root-fallback branch — the root occurrence's `relativePath` is
always `""`, which the loop's `relativePath !== "" && ...` guard always lets
through, so `best` can never stay `null` (a manifest is guaranteed exactly
one root occurrence, checked earlier in `runMergePipeline`).

**Edit 7 — call the validation before `publicationTargets`/`publishBases`**,
so a task whose declared files can't be verified in its recorded commit
aborts the run through the same `abortReason` path the base-drift check
already uses, before anything is published or an archive request is ever
built. This is the "before archiving task N against commit hash H, assert
every path in `files` resolves in H" invariant from the brief.

Current (verbatim, the base-drift check immediately followed by
`publicationTargets`):
```
        for (const occurrence of manifest.occurrences) { const liveOid = readCurrentRefOid(coordinates.get(occurrence.occurrenceId)!.repoRoot, `refs/heads/${occurrence.baseBranch}`); if (liveOid !== occurrence.baseOid) { abortReason = `the source branch moved past the pinned baseOid (pinned ${occurrence.baseOid}, now ${liveOid})`; return true; } }
        const publicationTargets: PublicationTarget[] = logicalGroups.map((group) => {
```
Becomes:
```
        for (const occurrence of manifest.occurrences) { const liveOid = readCurrentRefOid(coordinates.get(occurrence.occurrenceId)!.repoRoot, `refs/heads/${occurrence.baseBranch}`); if (liveOid !== occurrence.baseOid) { abortReason = `the source branch moved past the pinned baseOid (pinned ${occurrence.baseOid}, now ${liveOid})`; return true; } }
        const tasksForValidation = sortedGroups.flatMap((group) => group.tasks.map((task) => ({ number: task.number, files: task.files })));
        const validationFailure = findTaskArchivalValidationFailure(tasksForValidation, manifest, coordinates, logicalGroups, consolidations);
        if (validationFailure !== null) { abortReason = validationFailure; return true; }
        const publicationTargets: PublicationTarget[] = logicalGroups.map((group) => {
```

**Edit 8 — add an `archiveRequest` parameter to `printResult`.**

Current (line 159):
```
    const printResult = (publicationTargets: PublicationTargetSummary[], abortReason: string | null = null): void => { process.stdout.write(JSON.stringify({ merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, publicationTargets, abortReason })); };
```
Becomes:
```
    const printResult = (publicationTargets: PublicationTargetSummary[], abortReason: string | null = null, archiveRequest: ArchiveRequest | null = null): void => { process.stdout.write(JSON.stringify({ merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, publicationTargets, abortReason, archiveRequest })); };
```
Both existing abort/not-ready call sites (`printResult([]);` and
`printResult([], abortReason);`) are unchanged text and now correctly print
`archiveRequest: null` by default — satisfying "blocked output must carry
no archive request" with no edit to those call sites.

**Edit 9 — stop archiving in the success branch; build the owning-repo-only
`rawOutcomes` and an `archiveRequest` instead.**

Current (verbatim, lines 232-245):
```
        const rawOutcomes: RawTaskRepoOutcome[] = sortedGroups.flatMap((group) => group.tasks.flatMap((task) => logicalGroups.map((logicalGroup) => ({
            taskNumber: task.number, repo: { repoName: logicalGroup.logicalId, status: "published" as const, commitHash: consolidations.get(logicalGroup.logicalId)!.preparedIntegrationOid },
        }))));
        const mergeResults = summarizeTaskMergeResults(rawOutcomes);
        archivePublishedTasks(sortedGroups.flatMap((group) => group.tasks.map((task) => task.number)), mergeResults, input.repo);
        for (const resolvePath of [resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath]) rmSync(resolvePath(input.repo), { force: true });
        const summaryTargets: PublicationTargetSummary[] = manifest.occurrences.map((occurrence) => {
            const group = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            const consolidation = consolidations.get(group.logicalId)!;
            return { repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath, recordedBaseOid: occurrence.baseOid, targetOid: consolidation.preparedIntegrationOid };
        });
        endMetrics(0);
        printResult(summaryTargets);
        return false;
```
Becomes:
```
        const rawOutcomes: RawTaskRepoOutcome[] = sortedGroups.flatMap((group) => group.tasks.flatMap((task) => {
            const owningLogicalIds = taskFilesByLogicalId(task.files, manifest, coordinates, logicalGroups);
            return [...owningLogicalIds].map((logicalId) => ({
                taskNumber: task.number, repo: { repoName: logicalId, status: "published" as const, commitHash: consolidations.get(logicalId)!.preparedIntegrationOid },
            }));
        }));
        const mergeResults = summarizeTaskMergeResults(rawOutcomes);
        for (const resolvePath of [resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath]) rmSync(resolvePath(input.repo), { force: true });
        const summaryTargets: PublicationTargetSummary[] = manifest.occurrences.map((occurrence) => {
            const group = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            const consolidation = consolidations.get(group.logicalId)!;
            return { repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath, recordedBaseOid: occurrence.baseOid, targetOid: consolidation.preparedIntegrationOid };
        });
        const archiveRequest: ArchiveRequest = { publishedTaskNumbers: sortedGroups.flatMap((group) => group.tasks.map((task) => task.number)), mergeResults };
        endMetrics(0);
        printResult(summaryTargets, null, archiveRequest);
        return false;
```

No archival call remains anywhere in `mergePipeline.ts`. The only thing the
success path now does differently from a blocked path is include a
non-null `archiveRequest` in its JSON — the actual archiving happens one
process up, only after that process has judged the run `merged`.

### 3. `scripts/runMergePhase.ts`

**Edit 1 — import `archivePublishedTasks` and the types it needs.**

Current (line 6):
```
import type { CliInput } from "./mergePipeline.ts";
```
Becomes:
```
import type { CliInput } from "./mergePipeline.ts";
import { archivePublishedTasks, type ArchiveRequest, type TaskMergeResult } from "./taskArchival.ts";
```

**Edit 2 — add `archiveIfMerged`**, inserted right after `blockedVerdict`
(current lines 66-68) and before `resultIndicatesBaseDrift`. It only ever
calls `archive` when `verdict.status === "merged"`. Before calling it,
every uniquely-requested task number in the `archiveRequest` must resolve
to exactly one `mergeResult` that is `fullyPublished`, has at least one
repository, and whose repositories are all `"published"` with a non-empty
`commitHash` — otherwise `archiveIfMerged` returns `blocked` without
invoking `archive` at all, closing the reviewer's `{ publishedTaskNumbers:
[7], mergeResults: [] }` example and any "some tasks valid, some not"
mixed request. After `archive` runs, its returned `{ archived, leftOpen }`
must cover the full requested set (every requested task number present in
`archived`, none present in `leftOpen`), or the verdict is blocked even
though `archive` itself didn't throw. A missing/incomplete request, a
thrown exception, or an incomplete archival result are all funneled through
the existing `blockedVerdict` helper rather than a new one.

Current (verbatim):
```
function blockedVerdict(repo: string, failedCommand: string, error: string): MergePhaseVerdict {
    return { status: "blocked", result: null, failure: { repo, failedCommand, conflicts: [], error } };
}
```
Becomes:
```
function blockedVerdict(repo: string, failedCommand: string, error: string): MergePhaseVerdict {
    return { status: "blocked", result: null, failure: { repo, failedCommand, conflicts: [], error } };
}

function isArchiveRequest(value: unknown): value is ArchiveRequest {
    const request = value as Partial<ArchiveRequest> | null | undefined;
    return !!request && Array.isArray(request.publishedTaskNumbers) && Array.isArray(request.mergeResults);
}

// Requires the flag, at least one repo, and every repo published with a commit hash.
function isFullyPublishable(result: TaskMergeResult | undefined): result is TaskMergeResult {
    return !!result
        && result.fullyPublished
        && result.repos.length > 0
        && result.repos.every((repo) => repo.status === "published" && !!repo.commitHash);
}

// Every uniquely-requested task must resolve to exactly one fully-publishable mergeResult before archival is even attempted.
function archiveRequestIsComplete(request: ArchiveRequest): boolean {
    for (const taskNumber of new Set(request.publishedTaskNumbers)) {
        const matches = request.mergeResults.filter((result) => result.taskNumber === taskNumber);
        if (matches.length !== 1 || !isFullyPublishable(matches[0])) return false;
    }
    return true;
}

export function archiveIfMerged(
    verdict: MergePhaseVerdict,
    repo: string,
    failedCommand: string,
    archive: typeof archivePublishedTasks,
): MergePhaseVerdict {
    if (verdict.status !== "merged") return verdict;
    const archiveRequest = (verdict.result as { archiveRequest?: unknown } | null)?.archiveRequest;
    if (!isArchiveRequest(archiveRequest) || !archiveRequestIsComplete(archiveRequest)) {
        return blockedVerdict(repo, failedCommand, "merge script reported a merged verdict with no valid, complete archiveRequest; refusing to archive");
    }
    try {
        const { archived, leftOpen } = archive(archiveRequest.publishedTaskNumbers, archiveRequest.mergeResults, repo);
        const requested = new Set(archiveRequest.publishedTaskNumbers);
        const archivedSet = new Set(archived);
        const archivedEverything = requested.size === archivedSet.size && [...requested].every((taskNumber) => archivedSet.has(taskNumber));
        const noneLeftOpen = [...requested].every((taskNumber) => !leftOpen.includes(taskNumber));
        if (!archivedEverything || !noneLeftOpen) {
            return blockedVerdict(repo, failedCommand, `archival reported an incomplete result: archived [${archived.join(", ")}], leftOpen [${leftOpen.join(", ")}], requested [${[...requested].join(", ")}]`);
        }
        return verdict;
    } catch (error) {
        return blockedVerdict(repo, failedCommand, `archival failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
```

**Edit 3 — call `archiveIfMerged` in `runAsCli`, after the initial/retry
verdict is final.**

Current (verbatim, lines 204-206):
```
    const initialVerdict = judgeMergeRun(runScript(command), repoRoot, command.join(" "));
    const verdict = confirmedBaseDrift(initialVerdict) ? coordinateMergeRetry(runArguments, command, deps) : initialVerdict;
    process.stdout.write(JSON.stringify(verdict));
```
Becomes:
```
    const initialVerdict = judgeMergeRun(runScript(command), repoRoot, command.join(" "));
    const verdict = confirmedBaseDrift(initialVerdict) ? coordinateMergeRetry(runArguments, command, deps) : initialVerdict;
    const finalVerdict = archiveIfMerged(verdict, repoRoot, command.join(" "), archivePublishedTasks);
    process.stdout.write(JSON.stringify(finalVerdict));
```

`verdict` here is already the outcome of *both* the initial run and, if a
confirmed base drift happened, the retry (`coordinateMergeRetry`, which
itself calls `judgeMergeRun` again on the retried subprocess). Both paths
converge to this one line before archival ever runs, so archival now
strictly follows the true final verdict regardless of which path produced
it — this is what closes Problem 1's ordering half; the transactional
rewrite of `archivePublishedTasks` itself (see `scripts/taskArchival.ts`
above) closes its rollback-safety half.

## Tests

### Reviewer-mandated tests (replacing the deleted source-position test)

The previous plan's `tests/mergePipeline.test.ts` ended with a test that
checked `archivePublishedTasks(...)` appeared after `rmSync`/`printResult`
by byte offset in the source. That test is deleted outright — the function
call it was pinning no longer exists in `mergePipeline.ts` at all. It is
replaced by the following tests, revised this round to close the two new
PROBLEMS:

1. **File:** `tests/mergePipeline.test.ts`. **Asserts:** a `blocked`
   `MergePhaseVerdict` passed to `archiveIfMerged` never invokes the
   injected `archive` function, even if `verdict.result` happens to carry
   an `archiveRequest` — proving blocked verdicts never archive.
2. **File:** `tests/mergePipeline.test.ts`. **Asserts:** a `merged`
   `MergePhaseVerdict` carrying a complete, valid `archiveRequest` causes
   the injected `archive` function to be called exactly once, with the
   request's `publishedTaskNumbers`; the returned verdict is exactly the
   input `verdict` — proving the archived/leftOpen postcondition (`archived`
   covers every requested task, `leftOpen` contains none of them) is what
   keeps a `merged` verdict `merged`.
3. **File:** `tests/mergePipeline.test.ts`. **Asserts:** two cases where
   the pre-archival completeness gate must reject before `archive` is ever
   called: (a) a requested task with no corresponding `mergeResult` at all
   (the reviewer's exact `{ publishedTaskNumbers: [7], mergeResults: [] }`
   example), and (b) a mixed request where one requested task has a valid
   `fullyPublished` `mergeResult` but a second requested task has none —
   both prove archival is never attempted on an incomplete batch.
4. **File:** `tests/mergePipeline.test.ts`. **Asserts:** three
   failure-after-the-gate cases: (a) a `merged` verdict whose `result`
   carries no `archiveRequest` at all never calls `archive` and comes back
   `blocked`; (b) a structurally-complete `archiveRequest` whose injected
   `archive` function throws also comes back `blocked`, with the thrown
   message surfaced in `failure.error`; (c) an injected `archive` function
   that returns *without* throwing but whose `{ archived, leftOpen }`
   leaves a requested task uncovered (still in `leftOpen`) also comes back
   `blocked` — proving the post-archival completeness check catches an
   `archive` implementation that lies about success even when it doesn't
   throw.
5. **File:** `tests/mergePipeline.test.ts`. **Asserts:** calling
   `taskFilesByLogicalId(["sub"], manifest, coordinates, logicalGroups)`
   (where `"sub"` is exactly a submodule occurrence's checkout path)
   resolves to the **root** occurrence's logical id, not the submodule's —
   proving exact submodule checkout paths resolve to the parent
   repository.

`tests/taskArchival.test.ts` separately gains a transactional-rollback
test — see its section below — covering Problem 1's write-safety half:
forcing the second of the two `writeFileSync` calls to fail once and
asserting both `tasks.json` and `completedTasks.json` come back
byte-identical to their pre-call contents.

`scripts/runMergePhase.ts` gains `archiveIfMerged` and exports
`MergePhaseVerdict` (see "Exact edits" above), but `tests/runMergePhase.test.ts`
is not in this task's owned files and is left untouched — the
`archiveIfMerged` tests below live in `tests/mergePipeline.test.ts` instead,
importing `archiveIfMerged` and `MergePhaseVerdict` from
`../scripts/runMergePhase.ts` the same way any other test file imports from
a script it doesn't own.

### `tests/mergePipeline.test.ts` (new file)

This file does not exist yet; create it with the following content. It
covers the "Additional standing requirement" from the brief (every declared
file must resolve in its recorded commit, checked per owning repository)
plus the reviewer's `archiveIfMerged` tests.

```
// Behavioral checks: an integration commit must change and carry every declared file, verified against its owning repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildCoordinates,
    buildLogicalGroups,
    topoOrderLogicalGroups,
    taskFilesByLogicalId,
    findTaskArchivalValidationFailure,
    type ConsolidationOutcome,
} from "../scripts/mergePipeline.ts";
import { archiveIfMerged, type MergePhaseVerdict } from "../scripts/runMergePhase.ts";
import type { RepositoryManifest, RepositoryOccurrence } from "../scripts/repositoryManifest.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function initRepoWithFile(repoRoot: string, relativePath: string, content: string): string {
    mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "test");
    writeFileSync(join(repoRoot, relativePath), content);
    git(repoRoot, "add", relativePath);
    git(repoRoot, "commit", "-q", "-m", "init");
    return git(repoRoot, "rev-parse", "HEAD").trim();
}

function makeOccurrence(overrides: Partial<RepositoryOccurrence> & Pick<RepositoryOccurrence, "occurrenceId" | "checkoutPath">): RepositoryOccurrence {
    return {
        parentOccurrenceId: null, pathInParent: null, gitlinkOid: null, depth: 0,
        originUrl: "", baseBranch: "main", baseOid: "", operationBranch: "operations/x",
        childOccurrenceIds: [], testState: "untested",
        ...overrides,
    };
}

// Two independent git repositories: rootRepo (root occurrence) and rootRepo/sub (submodule-shaped occurrence), each with one base commit.
function makeManifestAndCoordinates(repoRootDir: string) {
    const rootRepo = repoRootDir;
    const subRepo = join(repoRootDir, "sub");
    const rootBaseOid = initRepoWithFile(rootRepo, "base.txt", "base");
    const subBaseOid = initRepoWithFile(subRepo, "existing.ts", "already here");

    const manifest: RepositoryManifest = {
        version: 1,
        occurrences: [
            makeOccurrence({ occurrenceId: "root", checkoutPath: rootRepo, baseOid: rootBaseOid, childOccurrenceIds: ["sub"] }),
            makeOccurrence({ occurrenceId: "sub", checkoutPath: subRepo, parentOccurrenceId: "root", pathInParent: "sub", depth: 1, baseOid: subBaseOid }),
        ],
    };
    const coordinates = buildCoordinates(rootRepo, manifest);
    const logicalGroups = topoOrderLogicalGroups(buildLogicalGroups(manifest), manifest);
    return { manifest, coordinates, logicalGroups, rootRepo, subRepo, rootBaseOid, subBaseOid };
}

test("a task declaring no files is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups } = makeManifestAndCoordinates(join(dir, "repo"));
    const failure = findTaskArchivalValidationFailure([{ number: 1, files: [] }], manifest, coordinates, logicalGroups, new Map());
    assert.match(failure ?? "", /declares no files/);
});

test("a changed commit that carries the declared file passes validation", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups, rootRepo, rootBaseOid } = makeManifestAndCoordinates(join(dir, "repo"));
    writeFileSync(join(rootRepo, "declared.ts"), "code");
    git(rootRepo, "add", "declared.ts");
    git(rootRepo, "commit", "-q", "-m", "add declared.ts");
    const integrationOid = git(rootRepo, "rev-parse", "HEAD").trim();
    const rootLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("root"))!.logicalId;
    const consolidations = new Map<string, ConsolidationOutcome>([
        [rootLogicalId, { preparedIntegrationOid: integrationOid, canonicalRepoRoot: rootRepo, canonicalRefName: "refs/heads/main", recordedBaseOid: rootBaseOid, integrationRef: "refs/x" }],
    ]);
    const failure = findTaskArchivalValidationFailure([{ number: 1, files: ["declared.ts"] }], manifest, coordinates, logicalGroups, consolidations);
    assert.equal(failure, null);
});

test("a changed commit missing the declared path is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups, rootRepo, rootBaseOid } = makeManifestAndCoordinates(join(dir, "repo"));
    writeFileSync(join(rootRepo, "other.ts"), "code");
    git(rootRepo, "add", "other.ts");
    git(rootRepo, "commit", "-q", "-m", "add other.ts");
    const integrationOid = git(rootRepo, "rev-parse", "HEAD").trim();
    const rootLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("root"))!.logicalId;
    const consolidations = new Map<string, ConsolidationOutcome>([
        [rootLogicalId, { preparedIntegrationOid: integrationOid, canonicalRepoRoot: rootRepo, canonicalRefName: "refs/heads/main", recordedBaseOid: rootBaseOid, integrationRef: "refs/x" }],
    ]);
    const failure = findTaskArchivalValidationFailure([{ number: 1, files: ["declared.ts"] }], manifest, coordinates, logicalGroups, consolidations);
    assert.match(failure ?? "", /missing from commit/);
});

test("an empty commit inheriting a pre-existing declared file is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups, subRepo, subBaseOid } = makeManifestAndCoordinates(join(dir, "repo"));
    git(subRepo, "commit", "--allow-empty", "-q", "-m", "no-op consolidation");
    const noOpOid = git(subRepo, "rev-parse", "HEAD").trim();
    const subLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("sub"))!.logicalId;
    const consolidations = new Map<string, ConsolidationOutcome>([
        [subLogicalId, { preparedIntegrationOid: noOpOid, canonicalRepoRoot: subRepo, canonicalRefName: "refs/heads/main", recordedBaseOid: subBaseOid, integrationRef: "refs/x" }],
    ]);
    // existing.ts is present in noOpOid's tree unchanged; only the tree-diff check catches this.
    const failure = findTaskArchivalValidationFailure([{ number: 1, files: ["sub/existing.ts"] }], manifest, coordinates, logicalGroups, consolidations);
    assert.match(failure ?? "", /no changes from its recorded base/);
});

test("a task spanning root and submodule paths validates each against its own repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups, rootRepo, rootBaseOid, subRepo, subBaseOid } = makeManifestAndCoordinates(join(dir, "repo"));
    writeFileSync(join(rootRepo, "declared.ts"), "code");
    git(rootRepo, "add", "declared.ts");
    git(rootRepo, "commit", "-q", "-m", "root change");
    const rootIntegrationOid = git(rootRepo, "rev-parse", "HEAD").trim();

    writeFileSync(join(subRepo, "sub-declared.ts"), "code");
    git(subRepo, "add", "sub-declared.ts");
    git(subRepo, "commit", "-q", "-m", "sub change");
    const subIntegrationOid = git(subRepo, "rev-parse", "HEAD").trim();

    const rootLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("root"))!.logicalId;
    const subLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("sub"))!.logicalId;
    const consolidations = new Map<string, ConsolidationOutcome>([
        [rootLogicalId, { preparedIntegrationOid: rootIntegrationOid, canonicalRepoRoot: rootRepo, canonicalRefName: "refs/heads/main", recordedBaseOid: rootBaseOid, integrationRef: "refs/x" }],
        [subLogicalId, { preparedIntegrationOid: subIntegrationOid, canonicalRepoRoot: subRepo, canonicalRefName: "refs/heads/main", recordedBaseOid: subBaseOid, integrationRef: "refs/y" }],
    ]);
    // sub/sub-declared.ts must resolve to sub-declared.ts and be checked against subRepo, not rootRepo.
    const failure = findTaskArchivalValidationFailure(
        [{ number: 1, files: ["declared.ts", "sub/sub-declared.ts"] }],
        manifest, coordinates, logicalGroups, consolidations,
    );
    assert.equal(failure, null);
});

test("an exact submodule checkout path resolves to the parent repository, not the submodule", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-mergepipeline-"));
    const { manifest, coordinates, logicalGroups } = makeManifestAndCoordinates(join(dir, "repo"));
    const rootLogicalId = logicalGroups.find((g) => g.occurrenceIds.includes("root"))!.logicalId;
    const owningLogicalIds = taskFilesByLogicalId(["sub"], manifest, coordinates, logicalGroups);
    assert.deepEqual([...owningLogicalIds], [rootLogicalId]);
});

test("test_archiveIfMergedNeverCallsArchiveForABlockedVerdict", () => {
    const verdict: MergePhaseVerdict = {
        status: "blocked",
        result: { archiveRequest: { publishedTaskNumbers: [1], mergeResults: [] } },
        failure: { repo: "/repo", failedCommand: "cmd", conflicts: [], error: "boom" },
    };
    let called = false;
    const result = archiveIfMerged(verdict, "/repo", "cmd", () => { called = true; return { archived: [], leftOpen: [] }; });

    assert.equal(called, false);
    assert.deepEqual(result, verdict);
});

test("test_archiveIfMergedArchivesExactlyOnceForAMergedVerdict", () => {
    const archiveRequest = {
        publishedTaskNumbers: [7],
        mergeResults: [{ taskNumber: 7, repos: [{ repoName: "r1", status: "published" as const, commitHash: "aaa" }], fullyPublished: true }],
    };
    const verdict: MergePhaseVerdict = { status: "merged", result: { archiveRequest }, failure: null };
    let callCount = 0;
    const result = archiveIfMerged(verdict, "/repo", "cmd", (publishedTaskNumbers) => {
        callCount++;
        assert.deepEqual(publishedTaskNumbers, [7]);
        return { archived: [7], leftOpen: [] };
    });

    assert.equal(callCount, 1);
    assert.equal(result.status, "merged");
    // Postcondition: archived covers the requested set, leftOpen has none of it, so the verdict passes through.
    assert.deepEqual(result, verdict);
});

test("test_archiveIfMergedBlocksWithoutCallingArchiveForAMissingOrMixedResult", () => {
    let called = false;
    const failIfCalled = () => { called = true; return { archived: [], leftOpen: [] }; };

    const missingResultVerdict: MergePhaseVerdict = {
        status: "merged",
        result: { archiveRequest: { publishedTaskNumbers: [7], mergeResults: [] } },
        failure: null,
    };
    const missingResultOutcome = archiveIfMerged(missingResultVerdict, "/repo", "cmd", failIfCalled);
    assert.equal(called, false);
    assert.equal(missingResultOutcome.status, "blocked");

    const mixedRequestVerdict: MergePhaseVerdict = {
        status: "merged",
        result: {
            archiveRequest: {
                publishedTaskNumbers: [7, 8],
                mergeResults: [
                    { taskNumber: 7, repos: [{ repoName: "r1", status: "published", commitHash: "aaa" }], fullyPublished: true },
                ],
            },
        },
        failure: null,
    };
    const mixedOutcome = archiveIfMerged(mixedRequestVerdict, "/repo", "cmd", failIfCalled);
    assert.equal(called, false);
    assert.equal(mixedOutcome.status, "blocked");
});

test("test_archiveIfMergedBlocksOnAMissingRequestOrAnIncompleteOrFailedArchival", () => {
    const missingPayload: MergePhaseVerdict = { status: "merged", result: {}, failure: null };
    let calledForMissingPayload = false;
    const missingResult = archiveIfMerged(missingPayload, "/repo", "cmd", () => {
        calledForMissingPayload = true;
        return { archived: [], leftOpen: [] };
    });
    assert.equal(calledForMissingPayload, false);
    assert.equal(missingResult.status, "blocked");
    assert.match(missingResult.failure?.error ?? "", /no valid, complete archiveRequest/);

    const completeRequest = {
        publishedTaskNumbers: [7],
        mergeResults: [{ taskNumber: 7, repos: [{ repoName: "r1", status: "published" as const, commitHash: "aaa" }], fullyPublished: true }],
    };

    const throwingVerdict: MergePhaseVerdict = { status: "merged", result: { archiveRequest: completeRequest }, failure: null };
    const throwingResult = archiveIfMerged(throwingVerdict, "/repo", "cmd", () => { throw new Error("task 7 declares no files"); });
    assert.equal(throwingResult.status, "blocked");
    assert.match(throwingResult.failure?.error ?? "", /task 7 declares no files/);

    const incompleteVerdict: MergePhaseVerdict = { status: "merged", result: { archiveRequest: completeRequest }, failure: null };
    const incompleteResult = archiveIfMerged(incompleteVerdict, "/repo", "cmd", () => ({ archived: [], leftOpen: [7] }));
    assert.equal(incompleteResult.status, "blocked");
    assert.match(incompleteResult.failure?.error ?? "", /incomplete/);
});
```

### `tests/taskArchival.test.ts` (edits)

**Edit 1 — give every fixture task a non-empty `files` array**, so the new
preflight guard doesn't throw on every existing "archives successfully"
test.

Current (lines 13-27):
```
function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "taskTools-archival-"));
    writeFileSync(
        join(root, "tasks.json"),
        JSON.stringify([
            { taskNumber: 1, title: "partial rollback" },
            { taskNumber: 2, title: "fully published" },
            { taskNumber: 3, title: "conflicted" },
            { taskNumber: 4, title: "skipped" },
            { taskNumber: 5, title: "not in explicit list" },
        ]),
    );
    writeFileSync(join(root, "completedTasks.json"), "[]");
    return root;
}
```
Becomes:
```
function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "taskTools-archival-"));
    writeFileSync(
        join(root, "tasks.json"),
        JSON.stringify([
            { taskNumber: 1, title: "partial rollback", files: ["a.ts"] },
            { taskNumber: 2, title: "fully published", files: ["b.ts"] },
            { taskNumber: 3, title: "conflicted", files: ["c.ts"] },
            { taskNumber: 4, title: "skipped", files: ["d.ts"] },
            { taskNumber: 5, title: "not in explicit list", files: ["e.ts"] },
        ]),
    );
    writeFileSync(join(root, "completedTasks.json"), "[]");
    return root;
}
```

This is safe against every one of the 8 existing tests: none of them
depend on a task having *no* `files`, and each existing assertion (which
tasks land in `archived`/`leftOpen`/`completedTasks.json`) is driven by
`RawTaskRepoOutcome.status`/`commitHash`, not by the fixture's `files`
field.

**Edit 2 — append two tests at the end of the file**, covering Problem 2's
fix (preflight throws before any write, for the whole batch, not just the
invalid candidate):
```
test("a fully-published task with no declared files blocks the whole batch, archiving nothing", () => {
    const root = makeProjectRoot();
    const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
    tasks.find((t: any) => t.taskNumber === 2).files = [];
    writeFileSync(join(root, "tasks.json"), JSON.stringify(tasks));
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 1, repo: { repoName: "r1", status: "published", commitHash: "aaa" } },
        { taskNumber: 2, repo: { repoName: "r1", status: "published", commitHash: "bbb" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    assert.throws(() => archivePublishedTasks([1, 2], mergeResults, root), /declares no files/);
    assert.equal(readTasks(root).length, 5);
    assert.equal(readCompleted(root).length, 0);
});

test("a fully-published task with no usable commit hash throws before archiving any candidate", () => {
    const root = makeProjectRoot();
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 1, repo: { repoName: "r1", status: "published", commitHash: "aaa" } },
        { taskNumber: 2, repo: { repoName: "r1", status: "published" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    assert.throws(() => archivePublishedTasks([1, 2], mergeResults, root), /no usable commit hash/);
    assert.equal(readCompleted(root).length, 0);
});
```
This requires `readFileSync` in scope, which the file already imports
(line 4: `import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";`)
— no import edit needed for this file.

**Edit 3 — append a third test**, covering Problem 1's rollback fix: force
the second of the two `writeFileSync` calls to fail once via the new
injectable `writeFile` dependency, and assert both files are byte-identical
to their pre-call contents afterward.
```
test("a failing second write is rolled back, leaving both files exactly as they were", () => {
    const root = makeProjectRoot();
    const originalTasksRaw = readFileSync(join(root, "tasks.json"), "utf8");
    const originalCompletedRaw = readFileSync(join(root, "completedTasks.json"), "utf8");
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 2, repo: { repoName: "r1", status: "published", commitHash: "aaa" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);

    let callCount = 0;
    const flakyWrite = (path: string, data: string): void => {
        callCount++;
        if (callCount === 2) throw new Error("disk full");
        writeFileSync(path, data);
    };

    assert.throws(() => archivePublishedTasks([2], mergeResults, root, flakyWrite), /disk full/);
    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), originalTasksRaw);
    assert.equal(readFileSync(join(root, "completedTasks.json"), "utf8"), originalCompletedRaw);
});
```
`callCount === 1` is the `tasksPath` write (succeeds, actually mutating the
file on disk via the real `writeFileSync`); `callCount === 2` is the
`completedTasksPath` write (throws without writing); `callCount === 3` and
`4` are the rollback's two restore calls (both succeed via the real
`writeFileSync`, writing `tasksPath` back to `originalTasksRaw` — undoing
call 1 — and `completedTasksPath` back to `originalCompletedRaw`, which was
never actually changed on disk but is restored anyway). This requires
`writeFileSync` in scope, which the file already imports (same line 4
import as above) — no import edit needed for this file either.

## Verification

Run these after making all edits above (from the repo root):

```
bunx tsc --noEmit
```
Expected: no output, exit code 0.

```
bun test tests/taskArchival.test.ts
```
Expected: `11 pass`, `0 fail` (the original 8 tests, now passing against
fixtures that carry `files`, plus the 2 preflight-throw tests, plus the 1
new second-write-rollback test).

```
bun test tests/mergePipeline.test.ts
```
Expected: `10 pass`, `0 fail` — the 5 `findTaskArchivalValidationFailure`
cases, the exact-submodule-checkout ownership case, and the 4
`archiveIfMerged` cases (blocked-never-archives, merged-archives-once,
missing/mixed-request-blocks-before-calling-archive,
missing-payload/throw/incomplete-result-blocks-after-the-gate).

```
bun test tests/runMergePhase.test.ts
```
Expected: `6 pass`, `0 fail` — this file is not in this task's owned
files and is left unedited, so it stays at its original count.
