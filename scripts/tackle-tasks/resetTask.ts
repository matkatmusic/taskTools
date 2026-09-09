import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResetScope } from "../shared/contracts.ts";
import { configureGeneratedArtifactIsolation, writeTaskBriefToDisk } from "./shared/writeTaskBrief.ts";
import { resetAttemptCounts } from "./shared/taskRunState.ts";
import { readJsonFile } from "./shared/readJsonFile.ts";
import { writeCheckpoint } from "./shared/checkpoint.ts";
import { stagingWorktreePath } from "./shared/stagingWorktree.ts";
import { resolveTaskFiles, taskWorkflowDirectory } from "../shared/taskFiles.ts";
import { currentBranchName, submodulePaths } from "../shared/repositoryBranches.ts";
import { generateSteps, resolveDiagramFolderSetting } from "./generateSteps.ts";
import { loadRepositoryManifest, initializeSubmodulesInWorktree } from "../shared/prepareTasks.ts";
import { deleteTaskMergePersistence, removeTaskWorktreeAndBranches, findRecordedMergedCommit } from "../merge-worktree-tasks/mergeTaskWorktrees.ts";

// These blocks read plans/plan.json, plans/codex-review.json, or a prompt file. Cleanup removes those with the worktree and nothing keeps a copy, so a resume there has no input to work from. The brief is the one file a reset can make again.
// const BLOCKS_THAT_NEED_LOST_WORKTREE_FILES = [
//     "PLAN_THE_TASK", "WHAT_DID_THE_PLANNER_RETURN", "WRITE_CLARIFY_REQUEST", "CODEX_REVIEWS_PLAN", "WHAT_IS_REVIEW_VERDICT",
//     "IMPLEMENT_TASK", "FIX_IMPLEMENT_TASK_TESTS", "CODEX_REVIEWS_TESTS", "FIX_THE_CODEBASE_FOR_SUITE", "FIX_CONFLICTS",
// ];
// retired: that refusal existed because a plain reset removed the worktree; the "no worktree" throw below already guards this.

// A block name makes the next launch resume there instead of starting over. Returns the lines to say.
export async function resetTask(taskNumber: number, block: string): Promise<string> {
    const lines: string[] = [];
    if (!Number.isInteger(taskNumber) || taskNumber <= 0) throw new Error("usage: resetTask <taskNumber> [<block>]");
    const repoRoot = execSync("git rev-parse --show-toplevel").toString().trim();
    // The checkpoint's block is the full `<diagram>::<box>` key; the resume walk needs that, so a bare name gets resolved.
    const stepsConfigPath = join(taskWorkflowDirectory(resolveTaskFiles(repoRoot).tasksPath, taskNumber), "steps.json");
    // A run that failed before task 10 shipped has no per-task pair yet; regenerate one so reset stays usable.
    if (!existsSync(stepsConfigPath)) {
        mkdirSync(dirname(stepsConfigPath), { recursive: true });
        const diagramFolderSetting = resolveDiagramFolderSetting(repoRoot);
        generateSteps(diagramFolderSetting.diagramFolder, diagramFolderSetting.stepsRoot, stepsConfigPath, diagramFolderSetting.allowStubs);
    }
    const stepsByDiagram: Record<string, { box: string; script: string; next: string[] }[]> = JSON.parse(readFileSync(stepsConfigPath, "utf-8"));
    const stepKeysNamingBlock = Object.entries(stepsByDiagram).flatMap(([diagram, entries]) => entries.filter((entry) => entry.box === block).map(() => `${diagram}::${block}`));
    if (block !== "" && stepKeysNamingBlock.length !== 1) {
        throw new Error(`block ${block} names ${stepKeysNamingBlock.length} steps in steps.json: ${stepKeysNamingBlock.join(", ")}`);
    }
    const stepKey = stepKeysNamingBlock[0] ?? "";

    // Same walk as runStepHook.ts isInsideSourceLock: reachable from LOCK_SOURCE_REPO without entering an exit diagram.
    const stepsByKey = new Map<string, { next: string[]; diagram: string }>(Object.entries(stepsByDiagram).flatMap(([diagram, entries]) => entries.map((entry) => [`${diagram}::${entry.box}`, { ...entry, diagram }])));
    const getStepKey = (boxReference: string, fromDiagram: string): string => {
        if (boxReference.includes("::")) return boxReference;
        const sameDiagramKey = `${fromDiagram}::${boxReference}`;
        if (stepsByKey.has(sameDiagramKey)) return sameDiagramKey;
        return [...stepsByKey.keys()].find((key) => key.slice(key.indexOf("::") + 2) === boxReference) ?? sameDiagramKey;
    };
    const exitDiagrams = ["pipeline-failuresExit.mmd", "pipeline-mergeSucceededExit.mmd"];
    const lockStepKey = [...stepsByKey.keys()].find((key) => key.endsWith("::LOCK_SOURCE_REPO"));
    const reachedFromLock = new Set<string>();
    const toVisit = lockStepKey === undefined ? [] : stepsByKey.get(lockStepKey)!.next.map((box) => getStepKey(box, stepsByKey.get(lockStepKey)!.diagram));
    while (toVisit.length > 0) {
        const visiting = toVisit.pop()!;
        const step = stepsByKey.get(visiting);
        if (step === undefined || reachedFromLock.has(visiting) || exitDiagrams.includes(step.diagram)) continue;
        reachedFromLock.add(visiting);
        toVisit.push(...step.next.map((box) => getStepKey(box, step.diagram)));
    }
    // prepareResume re-takes the lock on the next launch when the checkpoint says it was held.
    const sourceLockHeld = reachedFromLock.has(stepKey);

    let scope: ResetScope = {};
    if (block !== "") {
        const script = Object.values(stepsByDiagram).flat().find((entry) => entry.box === block)!.script;
        const blockModule = await import(pathToFileURL(join(fileURLToPath(new URL("../..", import.meta.url)), script)).href);
        scope = blockModule.resetScope ?? {};
    }

    // repoRoot moved above, before stepsByDiagram is read (task 10).
    const { tasksPath: tasksFile, completedTasksPath: completedFile } = resolveTaskFiles(repoRoot);

    const tasks = JSON.parse(readFileSync(tasksFile, "utf-8"));
    const completed = JSON.parse(readFileSync(completedFile, "utf-8"));

    const openIndex = tasks.findIndex((t: any) => t.taskNumber === taskNumber);
    const completedIndex = completed.findIndex((t: any) => t.taskNumber === taskNumber);

    if (openIndex === -1 && completedIndex === -1) throw new Error(`task ${taskNumber} not found in tasks.json or completedTasks.json`);

    // Full reset: every repo walks back to its reset-point ref; guards run before any mutation.
    const resetPointRef = `refs/taskTools/reset-point/task-${taskNumber}`;
    let manifest: ReturnType<typeof loadRepositoryManifest> | undefined;
    let occurrencesDeepestFirst: ReturnType<typeof loadRepositoryManifest>["occurrences"] | undefined;
    let resetPointByOccurrence: Map<string, string> | undefined;
    let rootResetPoint: string | undefined;
    if (block === "") {
        manifest = loadRepositoryManifest(repoRoot, "staging");
        occurrencesDeepestFirst = [...manifest.occurrences].sort((a, b) => b.depth - a.depth);

        // Phase 1: guards only, no mutation. Root first, naming a later-merged task before a submodule's generic throw.
        resetPointByOccurrence = new Map<string, string>();
        const rootFirstOccurrences = [...occurrencesDeepestFirst].sort((a, b) => (a.occurrenceId === "" ? -1 : b.occurrenceId === "" ? 1 : 0));
        for (const occurrence of rootFirstOccurrences) {
            const resetPointProbe = spawnSync("git", ["-C", occurrence.checkoutPath, "rev-parse", "--verify", "--quiet", resetPointRef], { encoding: "utf8" });
            if (resetPointProbe.status === 1) throw new Error(`reset of task ${taskNumber} cannot run: no reset point in ${occurrence.checkoutPath}; reset it by hand`);
            const resetPoint = resetPointProbe.stdout.trim();
            resetPointByOccurrence.set(occurrence.occurrenceId, resetPoint);
            const stagingTip = execSync("git rev-parse staging", { cwd: occurrence.checkoutPath }).toString().trim();
            if (stagingTip === resetPoint) continue;
            const firstParentProbe = spawnSync("git", ["-C", occurrence.checkoutPath, "rev-parse", "--verify", "--quiet", `${stagingTip}^1`], { encoding: "utf8" });
            const secondParentProbe = spawnSync("git", ["-C", occurrence.checkoutPath, "rev-parse", "--verify", "--quiet", `${stagingTip}^2`], { encoding: "utf8" });
            if (secondParentProbe.status === 0 && firstParentProbe.stdout.trim() === resetPoint) continue;
            if (occurrence.occurrenceId === "") {
                // Merges on staging's first-parent line after this task's reset point, newest first, minus this task itself.
                const mergesAfter = execSync(`git rev-list --first-parent staging ^${resetPoint}`, { cwd: occurrence.checkoutPath }).toString().trim().split("\n").filter(Boolean);
                const tasksAfter = mergesAfter
                    .map((hash) => completed.find((t: any) => t.commitHashes?.[t.commitHashes.length - 1] === hash)?.taskNumber)
                    .filter((n) => n !== undefined && n !== taskNumber);
                throw new Error(`reset of ${taskNumber} blocked. reset ${tasksAfter.join(", ")} first to unblock`);
            }
            throw new Error(`reset of ${taskNumber} blocked in ${occurrence.checkoutPath}; a later merge sits on its reset point`);
        }
        rootResetPoint = resetPointByOccurrence.get("");
    }

    // same worktree-path formula as taskTools-86/scripts/shared/prepareTasks.ts:resolveTaskWorktreeConventionDirectory
    const hash = createHash("sha256").update(realpathSync(repoRoot)).digest("hex").slice(0, 8);
    const worktreePath = join(tmpdir(), "taskTools-wt", `${basename(repoRoot)}-${hash}`, `task-${taskNumber}`);
    const leasePath = `${worktreePath}.lease`;
    const branchName = `task-${taskNumber}`;

    // A full reset (block === "") removes the worktree/branch in every repo via removeTaskWorktreeAndBranches below.
    if (scope.worktree === true) {
        try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoRoot, stdio: "pipe" }); } catch { /* not registered */ }
        try { execSync(`git branch -D ${branchName}`, { cwd: repoRoot, stdio: "pipe" }); } catch { /* already gone */ }
    }
    if (block === "" || scope.worktree === true) {
        if (existsSync(leasePath)) rmSync(leasePath);
    }
    execSync("git worktree prune", { cwd: repoRoot, stdio: "pipe" });

    for (const f of [".git/taskTools-source.lock", ".git/taskTools-source.lock.mutation-guard"]) {
        const p = join(repoRoot, f);
        if (existsSync(p)) rmSync(p);
    }
    // for (const entry of existsSync(join(repoRoot, ".taskTools", "runs")) ? readdirSync(join(repoRoot, ".taskTools", "runs")) : []) {
    //     rmSync(join(repoRoot, ".taskTools", "runs", entry, "packets"), { recursive: true, force: true });
    // }
    // Only this task's run directories go: each packet JSON names its taskNumber.
    const runsDirectory = join(repoRoot, ".taskTools", "runs");
    for (const runDirectory of existsSync(runsDirectory) ? readdirSync(runsDirectory).map((entry) => join(runsDirectory, entry)) : []) {
        const packetsDirectory = join(runDirectory, "packets");
        if (!existsSync(packetsDirectory)) continue;
        const packetNamesThisTask = readdirSync(packetsDirectory)
            .some((packetFile) => {
                const packet = readJsonFile(join(packetsDirectory, packetFile)) as { taskNumber?: number; output?: { result?: { taskNumber?: number } } };
                return packet.taskNumber === taskNumber || packet.output?.result?.taskNumber === taskNumber;
            });
        // A reset to a block reads the block's input from these packets, so they stay.
        if (packetNamesThisTask && block === "") rmSync(runDirectory, { recursive: true, force: true });
    }
    if (block === "") {
        // Phase 2's deleteTaskMergePersistence below deletes this same ref.
        // try { execSync(`git update-ref -d refs/taskTools/merged-commits/${branchName}`, { cwd: repoRoot, stdio: "pipe" }); } catch { /* never merged */ }
        const agentsDirectory = join(repoRoot, ".claude", "agents");
        for (const agentFile of existsSync(agentsDirectory) ? readdirSync(agentsDirectory) : []) {
            if (agentFile.startsWith(`task-${taskNumber}-`) && agentFile.endsWith(".md")) rmSync(join(agentsDirectory, agentFile));
        }
    }

    // Phase 2: mutation, deepest first. Phase 1's guards already ran, right after the task lookup above.
    if (block === "") {
        for (const occurrence of occurrencesDeepestFirst!) {
            const resetPoint = resetPointByOccurrence!.get(occurrence.occurrenceId)!;
            const stagingCheckout = join(stagingWorktreePath(repoRoot), occurrence.occurrenceId);
            if (existsSync(join(stagingCheckout, ".git"))) {
                execSync(`git reset --hard ${resetPoint}`, { cwd: stagingCheckout, stdio: "pipe" });
            } else {
                execSync(`git branch -f staging ${resetPoint}`, { cwd: occurrence.checkoutPath, stdio: "pipe" });
            }
        }
        for (const occurrence of occurrencesDeepestFirst!) deleteTaskMergePersistence(occurrence.checkoutPath, branchName);
        const sourceSubmodules = manifest!.occurrences
            .filter((occurrence) => occurrence.occurrenceId !== "")
            .map((occurrence) => ({ checkoutPath: occurrence.checkoutPath, depth: occurrence.depth }));
        removeTaskWorktreeAndBranches(repoRoot, worktreePath, branchName, sourceSubmodules);
        for (const occurrence of manifest!.occurrences) {
            execSync(`git update-ref -d ${resetPointRef}`, { cwd: occurrence.checkoutPath, stdio: "pipe" });
        }
    }

    if (completedIndex !== -1) {
        const entry = completed[completedIndex];
        const workCommit = entry.commitHashes?.[0];
        const mergeCommit = entry.commitHashes?.[entry.commitHashes.length - 1];
        if (!workCommit || !mergeCommit) throw new Error(`task ${taskNumber}'s completedTasks.json entry has no commitHashes; can't compute a reset point`);
        // retired: the occurrence walk above now guards and resets staging in every repo, root included.
        // const foundBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot }).toString().trim();
        // const stagingTip = execSync("git rev-parse staging", { cwd: repoRoot }).toString().trim();
        // if (stagingTip !== mergeCommit) {
        //     // Merges on staging's first-parent line after this task's merge, newest first: the reset order that unblocks.
        //     const mergesAfter = execSync(`git rev-list --first-parent staging ^${mergeCommit}`, { cwd: repoRoot }).toString().trim().split("\n").filter(Boolean);
        //     const tasksAfter = mergesAfter
        //         .map((hash) => completed.find((t: any) => t.commitHashes?.[t.commitHashes.length - 1] === hash)?.taskNumber)
        //         .filter((n) => n !== undefined);
        //     throw new Error(`reset of ${taskNumber} blocked. reset ${tasksAfter.join(", ")} first to unblock`);
        // }
        // const resetTarget = execSync(`git rev-parse ${mergeCommit}^1`, { cwd: repoRoot }).toString().trim();
        // // The pipeline keeps staging checked out in its own worktree; git refuses a second checkout of it.
        // const stagingCheckout = stagingWorktreePath(repoRoot);
        // if (existsSync(join(stagingCheckout, ".git"))) {
        //     execSync(`git reset --hard ${resetTarget}`, { cwd: stagingCheckout, stdio: "pipe" });
        // } else {
        //     execSync(`git checkout staging`, { cwd: repoRoot, stdio: "pipe" });
        //     execSync(`git reset --hard ${resetTarget}`, { cwd: repoRoot, stdio: "pipe" });
        //     execSync(`git checkout ${foundBranch}`, { cwd: repoRoot, stdio: "pipe" });
        // }

        const { completionDate, commitHashes, closureNote, run, ...restored } = entry;
        completed.splice(completedIndex, 1);
        tasks.unshift(block === "" ? restored : { ...restored, run });
        writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
        writeFileSync(completedFile, JSON.stringify(completed, null, 2));
        lines.push(block === "" ? `task ${taskNumber} restored to tasks.json; staging reset to ${rootResetPoint}` : `task ${taskNumber} restored to tasks.json`);
        if (block !== "") {
            // The merge commit's second parent is the task branch tip before the merge.
            execSync(`git branch -f ${branchName} ${mergeCommit}^2`, { cwd: repoRoot, stdio: "pipe" });
            execSync(`git worktree add "${worktreePath}" ${branchName}`, { cwd: repoRoot, stdio: "pipe" });
            // Same two calls as DOCUMENT_GENERATION: the brief comes from tasks.json, so it can be made again.
            configureGeneratedArtifactIsolation(taskNumber, worktreePath);
            writeTaskBriefToDisk(taskNumber, worktreePath, repoRoot);

            // Populate worktree submodules, then put each on task-N at the commit its own merge record names.
            initializeSubmodulesInWorktree(worktreePath);
            const submoduleOccurrences = loadRepositoryManifest(repoRoot, "staging").occurrences.filter((occurrence) => occurrence.occurrenceId !== "");
            for (const occurrence of submoduleOccurrences) {
                const worktreeSubmodulePath = join(worktreePath, occurrence.occurrenceId);
                const mergeHash = findRecordedMergedCommit(occurrence.checkoutPath, branchName);
                const secondParentProbe = spawnSync("git", ["-C", occurrence.checkoutPath, "rev-parse", "--verify", "--quiet", `${mergeHash}^2`], { encoding: "utf8" });
                if (secondParentProbe.status === 0) {
                    execSync(`git branch -f ${branchName} ${secondParentProbe.stdout.trim()}`, { cwd: worktreeSubmodulePath, stdio: "pipe" });
                    execSync(`git checkout ${branchName}`, { cwd: worktreeSubmodulePath, stdio: "pipe" });
                } else {
                    execSync(`git checkout -B ${branchName} ${mergeHash}`, { cwd: worktreeSubmodulePath, stdio: "pipe" });
                }
            }
        }
    } else {
        const { run, codexReviewNotes, planReviewCount, clarifyRequest, ...restored } = tasks[openIndex];
        if (block === "") tasks[openIndex] = restored;
        writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
        lines.push(block === "" ? `task ${taskNumber} run state cleared` : `task ${taskNumber} run state kept`);
    }

    if (block !== "") {
        const runState = tasks.find((t: any) => t.taskNumber === taskNumber).run;
        const runId: string = runState.history[runState.history.length - 1].runId;
        if (scope.counters === true) resetAttemptCounts(taskNumber, runId, repoRoot);
        if (!existsSync(worktreePath)) throw new Error(`task ${taskNumber} has no worktree at ${worktreePath}; a reset to a block needs one`);
        // retired: rewindPoints restore below repoints every repo, replacing this plain checkout.
        // for (const path of submodulePaths(worktreePath, currentBranchName(worktreePath))) {
        //     execSync(`git checkout ${branchName}`, { cwd: join(worktreePath, path), stdio: "pipe" });
        // }

        // The block's input is the quoted argument of its newest packet this run, like resumeRun.ts findStartAtBlockEntry.
        const packetNamePattern = new RegExp(`^\\d+-${block}-\\d+-\\d+\\.json$`);
        let newestMtimeMs = -Infinity;
        let input: string | null = null;
        let rewindPoints: Record<string, string> = {};
        for (const stampEntry of existsSync(runsDirectory) ? readdirSync(runsDirectory) : []) {
            const packetsFolder = join(runsDirectory, stampEntry, "packets");
            if (!existsSync(packetsFolder)) continue;
            for (const packetName of readdirSync(packetsFolder)) {
                if (!packetNamePattern.test(packetName)) continue;
                const packetPath = join(packetsFolder, packetName);
                const packetJson = JSON.parse(readFileSync(packetPath, "utf-8"));
                const commandLine: string = packetJson.command;
                const quoteStart = commandLine.indexOf("'");
                if (quoteStart === -1) continue;
                let raw = "";
                let charIndex = quoteStart + 1;
                while (charIndex < commandLine.length) {
                    if (commandLine.slice(charIndex, charIndex + 4) === `'\\''`) {
                        raw += "'";
                        charIndex += 4;
                        continue;
                    }
                    if (commandLine[charIndex] === "'") break;
                    raw += commandLine[charIndex];
                    charIndex += 1;
                }
                if (JSON.parse(raw).runId !== runId) continue;
                const mtimeMs = statSync(packetPath).mtimeMs;
                if (mtimeMs <= newestMtimeMs) continue;
                newestMtimeMs = mtimeMs;
                input = raw;
                rewindPoints = packetJson.rewindPoints ?? {};
            }
        }
        if (input === null) throw new Error(`no packet for block ${block} of run ${runId} under ${runsDirectory}`);

        // Deepest submodule path first, root ("") last: task-N is already checked out at the root.
        for (const [occurrenceId, oid] of Object.entries(rewindPoints).sort(([a], [b]) => b.length - a.length)) {
            const path = occurrenceId === "" ? worktreePath : join(worktreePath, occurrenceId);
            if (occurrenceId === "") {
                execSync(`git reset --hard ${oid}`, { cwd: path, stdio: "pipe" });
            } else {
                execSync(`git checkout -B ${branchName} ${oid}`, { cwd: path, stdio: "pipe" });
            }
        }

        if (scope.generatedFiles === true) {
            const plansFolder = join(worktreePath, "plans");
            for (const file of existsSync(plansFolder) ? readdirSync(plansFolder) : []) {
                if (file === "plan.json") rmSync(join(plansFolder, file), { force: true });
                if (file === "codex-review.json") rmSync(join(plansFolder, file), { force: true });
                if (file.startsWith("PLAN_THE_TASK.")) rmSync(join(plansFolder, file), { force: true });
                if (file.endsWith(".prompt.md")) rmSync(join(plansFolder, file), { force: true });
            }
        }

        writeFileSync(leasePath, JSON.stringify({ pid: process.pid, runId }));
        writeCheckpoint(worktreePath, {
            taskNumber, passId: randomUUID(), runId, projectRoot: repoRoot,
            block: stepKey, input, state: "running", sourceLockHeld, exitType: "", exitNote: "", resumedFrom: null,
        });
        lines.push(`task ${taskNumber} resumes at ${stepKey} on the next /tackle-tasks [${taskNumber}]`);
        const cleared = Object.entries(scope).filter(([, value]) => value === true).map(([key]) => key);
        lines.push(`cleared: ${cleared.length > 0 ? cleared.join(", ") : "nothing"}`);
    }
    // Last: steps.json here was read at the top; a block reset keeps it for the resume.
    if (block === "") rmSync(dirname(stepsConfigPath), { recursive: true, force: true });
    return lines.join("\n");
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(await resetTask(Number(process.argv[2]), process.argv[3] ?? ""));
