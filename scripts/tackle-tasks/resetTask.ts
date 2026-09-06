import { execSync } from "node:child_process";
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
import { resolveTaskFiles, taskWorkflowDirectory } from "../shared/taskFiles.ts";
import { generateSteps, resolveDiagramFolderSetting } from "./generateSteps.ts";

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
    const stepsByDiagram: Record<string, { box: string; script: string }[]> = JSON.parse(readFileSync(stepsConfigPath, "utf-8"));
    const stepKeysNamingBlock = Object.entries(stepsByDiagram).flatMap(([diagram, entries]) => entries.filter((entry) => entry.box === block).map(() => `${diagram}::${block}`));
    if (block !== "" && stepKeysNamingBlock.length !== 1) {
        throw new Error(`block ${block} names ${stepKeysNamingBlock.length} steps in steps.json: ${stepKeysNamingBlock.join(", ")}`);
    }
    const stepKey = stepKeysNamingBlock[0] ?? "";

    let scope: ResetScope = {};
    if (block !== "") {
        const script = Object.values(stepsByDiagram).flat().find((entry) => entry.box === block)!.script;
        const blockModule = await import(pathToFileURL(join(fileURLToPath(new URL("../..", import.meta.url)), script)).href);
        scope = blockModule.resetScope ?? {};
    }

    // repoRoot moved above, before stepsByDiagram is read (task 10).
    const tasksFile = join(repoRoot, ".taskTools", "tasks.json");
    const completedFile = join(repoRoot, ".taskTools", "completedTasks.json");

    const tasks = JSON.parse(readFileSync(tasksFile, "utf-8"));
    const completed = JSON.parse(readFileSync(completedFile, "utf-8"));

    const openIndex = tasks.findIndex((t: any) => t.taskNumber === taskNumber);
    const completedIndex = completed.findIndex((t: any) => t.taskNumber === taskNumber);

    if (openIndex === -1 && completedIndex === -1) throw new Error(`task ${taskNumber} not found in tasks.json or completedTasks.json`);

    // same worktree-path formula as taskTools-86/scripts/shared/prepareTasks.ts:resolveTaskWorktreeConventionDirectory
    const hash = createHash("sha256").update(realpathSync(repoRoot)).digest("hex").slice(0, 8);
    const worktreePath = join(tmpdir(), "taskTools-wt", `${basename(repoRoot)}-${hash}`, `task-${taskNumber}`);
    const leasePath = `${worktreePath}.lease`;
    const branchName = `task-${taskNumber}`;

    if (block === "" || scope.worktree === true) {
        try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoRoot, stdio: "pipe" }); } catch { /* not registered */ }
        try { execSync(`git branch -D ${branchName}`, { cwd: repoRoot, stdio: "pipe" }); } catch { /* already gone */ }
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
    // Only this task's packets go: each packet JSON names its taskNumber; *-run-log.json names have no packets folder.
    const runsDirectory = join(repoRoot, ".taskTools", "runs");
    for (const packetsDirectory of existsSync(runsDirectory) ? readdirSync(runsDirectory).map((entry) => join(runsDirectory, entry, "packets")) : []) {
        if (!existsSync(packetsDirectory)) continue;
        const packetNamesThisTask = readdirSync(packetsDirectory)
            .some((packetFile) => {
                const packet = readJsonFile(join(packetsDirectory, packetFile)) as { taskNumber?: number; output?: { result?: { taskNumber?: number } } };
                return packet.taskNumber === taskNumber || packet.output?.result?.taskNumber === taskNumber;
            });
        // A reset to a block reads the block's input from these packets, so they stay.
        if (packetNamesThisTask && block === "") rmSync(packetsDirectory, { recursive: true, force: true });
    }

    if (completedIndex !== -1) {
        const entry = completed[completedIndex];
        const workCommit = entry.commitHashes?.[0];
        const mergeCommit = entry.commitHashes?.[entry.commitHashes.length - 1];
        if (!workCommit || !mergeCommit) throw new Error(`task ${taskNumber}'s completedTasks.json entry has no commitHashes; can't compute a reset point`);
        const foundBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot }).toString().trim();
        const stagingTip = execSync("git rev-parse staging", { cwd: repoRoot }).toString().trim();
        if (stagingTip !== mergeCommit) throw new Error(`refusing: staging (${stagingTip}) is not task ${taskNumber}'s merge commit (${mergeCommit}) — something else was merged after it. Reset manually.`);
        const resetTarget = execSync(`git rev-parse ${workCommit}^`, { cwd: repoRoot }).toString().trim();
        execSync(`git checkout staging`, { cwd: repoRoot, stdio: "pipe" });
        execSync(`git reset --hard ${resetTarget}`, { cwd: repoRoot, stdio: "pipe" });
        execSync(`git checkout ${foundBranch}`, { cwd: repoRoot, stdio: "pipe" });

        const { completionDate, commitHashes, closureNote, run, ...restored } = entry;
        completed.splice(completedIndex, 1);
        tasks.unshift(block === "" ? restored : { ...restored, run });
        writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
        writeFileSync(completedFile, JSON.stringify(completed, null, 2));
        lines.push(`task ${taskNumber} restored to tasks.json; master reset to ${resetTarget}`);
        if (block !== "") {
            // The merge commit's second parent is the task branch tip before the merge.
            execSync(`git branch -f ${branchName} ${mergeCommit}^2`, { cwd: repoRoot, stdio: "pipe" });
            execSync(`git worktree add "${worktreePath}" ${branchName}`, { cwd: repoRoot, stdio: "pipe" });
            // Same two calls as DOCUMENT_GENERATION: the brief comes from tasks.json, so it can be made again.
            configureGeneratedArtifactIsolation(taskNumber, worktreePath);
            writeTaskBriefToDisk(taskNumber, worktreePath, repoRoot);
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

        // The block's input is the quoted argument of its newest packet this run, like resumeRun.ts findStartAtBlockEntry.
        const packetNamePattern = new RegExp(`^${block}-\\d+-\\d+\\.json$`);
        let newestMtimeMs = -Infinity;
        let input: string | null = null;
        for (const stampEntry of existsSync(runsDirectory) ? readdirSync(runsDirectory) : []) {
            const packetsFolder = join(runsDirectory, stampEntry, "packets");
            if (!existsSync(packetsFolder)) continue;
            for (const packetName of readdirSync(packetsFolder)) {
                if (!packetNamePattern.test(packetName)) continue;
                const packetPath = join(packetsFolder, packetName);
                const commandLine: string = JSON.parse(readFileSync(packetPath, "utf-8")).command;
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
            }
        }
        if (input === null) throw new Error(`no packet for block ${block} of run ${runId} under ${runsDirectory}`);

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
            block: stepKey, input, state: "running", sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom: null,
        });
        lines.push(`task ${taskNumber} resumes at ${stepKey} on the next /tackle-tasks [${taskNumber}]`);
        const cleared = Object.entries(scope).filter(([, value]) => value === true).map(([key]) => key);
        lines.push(`cleared: ${cleared.length > 0 ? cleared.join(", ") : "nothing"}`);
    }
    return lines.join("\n");
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(await resetTask(Number(process.argv[2]), process.argv[3] ?? ""));
