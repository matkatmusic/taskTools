import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureGeneratedArtifactIsolation, writeTaskBriefToDisk } from "./shared/writeTaskBrief.ts";

// These blocks read plans/plan.json, plans/codex-review.json, or a prompt file. Cleanup removes those with the worktree and nothing keeps a copy, so a resume there has no input to work from. The brief is the one file a reset can make again.
const BLOCKS_THAT_NEED_LOST_WORKTREE_FILES = [
    "PLAN_THE_TASK", "WHAT_DID_THE_PLANNER_RETURN", "WRITE_CLARIFY_REQUEST", "CODEX_REVIEWS_PLAN", "WHAT_IS_REVIEW_VERDICT",
    "IMPLEMENT_TASK", "FIX_IMPLEMENT_TASK_TESTS", "CODEX_REVIEWS_TESTS", "FIX_THE_CODEBASE_FOR_SUITE", "FIX_CONFLICTS",
];

const taskNumber = Number(process.argv[2]);
// A block name makes the next plain launch resume at that block instead of starting over.
const block = process.argv[3] ?? "";
if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    console.error("usage: node resetTask.ts <taskNumber> [<block>]");
    process.exit(1);
}
if (BLOCKS_THAT_NEED_LOST_WORKTREE_FILES.includes(block)) {
    throw new Error(`cannot resume at ${block}: it reads plan, review, or prompt files that the worktree cleanup removed and nothing can make again`);
}
// The checkpoint's block is the full `<diagram>::<box>` key; the resume walk takes it as is, so a bare name is resolved here.
const stepsByDiagram: Record<string, { box: string }[]> = JSON.parse(readFileSync(fileURLToPath(new URL("../steps.json", import.meta.url)), "utf-8"));
const stepKeysNamingBlock = Object.entries(stepsByDiagram).flatMap(([diagram, entries]) => entries.filter((entry) => entry.box === block).map(() => `${diagram}::${block}`));
if (block !== "" && stepKeysNamingBlock.length !== 1) {
    throw new Error(`block ${block} names ${stepKeysNamingBlock.length} steps in steps.json: ${stepKeysNamingBlock.join(", ")}`);
}
const stepKey = stepKeysNamingBlock[0] ?? "";

const repoRoot = execSync("git rev-parse --show-toplevel").toString().trim();
const tasksFile = join(repoRoot, ".taskTools", "tasks.json");
const completedFile = join(repoRoot, ".taskTools", "completedTasks.json");

const tasks = JSON.parse(readFileSync(tasksFile, "utf-8"));
const completed = JSON.parse(readFileSync(completedFile, "utf-8"));

const openIndex = tasks.findIndex((t: any) => t.taskNumber === taskNumber);
const completedIndex = completed.findIndex((t: any) => t.taskNumber === taskNumber);

if (openIndex === -1 && completedIndex === -1) {
    console.error(`task ${taskNumber} not found in tasks.json or completedTasks.json`);
    process.exit(1);
}

// same worktree-path formula as taskTools-86/scripts/prepareTasks.ts:resolveTaskWorktreeConventionDirectory
const hash = createHash("sha256").update(realpathSync(repoRoot)).digest("hex").slice(0, 8);
const worktreePath = join(tmpdir(), "taskTools-wt", `${basename(repoRoot)}-${hash}`, `task-${taskNumber}`);
const leasePath = `${worktreePath}.lease`;
const branchName = `task-${taskNumber}`;

if (block === "") {
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
// Only this task's packets go: each packet JSON names its taskNumber; *-run-log.md names have no packets folder.
const runsDirectory = join(repoRoot, ".taskTools", "runs");
for (const packetsDirectory of existsSync(runsDirectory) ? readdirSync(runsDirectory).map((entry) => join(runsDirectory, entry, "packets")) : []) {
    if (!existsSync(packetsDirectory)) continue;
    const packetNamesThisTask = readdirSync(packetsDirectory)
        .some((packetFile) => {
            const packet = JSON.parse(readFileSync(join(packetsDirectory, packetFile), "utf-8"));
            return packet.taskNumber === taskNumber || packet.output?.result?.taskNumber === taskNumber;
        });
    // A reset to a block reads the block's input from these packets, so they stay.
    if (packetNamesThisTask && block === "") rmSync(packetsDirectory, { recursive: true, force: true });
}

if (completedIndex !== -1) {
    const entry = completed[completedIndex];
    const workCommit = entry.commitHashes?.[0];
    const mergeCommit = entry.commitHashes?.[entry.commitHashes.length - 1];
    if (!workCommit || !mergeCommit) {
        console.error(`task ${taskNumber}'s completedTasks.json entry has no commitHashes; can't compute a reset point`);
        process.exit(1);
    }
    const head = execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim();
    if (head !== mergeCommit) {
        console.error(`refusing: HEAD (${head}) is not task ${taskNumber}'s merge commit (${mergeCommit}) — something else was merged after it. Reset manually.`);
        process.exit(1);
    }
    const resetTarget = execSync(`git rev-parse ${workCommit}^`, { cwd: repoRoot }).toString().trim();
    execSync(`git reset --hard ${resetTarget}`, { cwd: repoRoot, stdio: "inherit" });

    const { completionDate, commitHashes, closureNote, run, ...restored } = entry;
    completed.splice(completedIndex, 1);
    tasks.unshift(block === "" ? restored : { ...restored, run });
    writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
    writeFileSync(completedFile, JSON.stringify(completed, null, 2));
    console.log(`task ${taskNumber} restored to tasks.json; master reset to ${resetTarget}`);
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
    console.log(block === "" ? `task ${taskNumber} run state cleared` : `task ${taskNumber} run state kept`);
}

if (block !== "") {
    const runState = tasks.find((t: any) => t.taskNumber === taskNumber).run;
    const runId: string = runState.history[runState.history.length - 1].runId;
    if (!existsSync(worktreePath)) throw new Error(`task ${taskNumber} has no worktree at ${worktreePath}; a reset to a block needs one`);

    // The block's input is the quoted argument of the newest packet for that block from this run. Same scan as resumeRun.ts findStartAtBlockEntry.
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

    writeFileSync(leasePath, JSON.stringify({ pid: process.pid, runId }));
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "checkpoint.json"), JSON.stringify({
        taskNumber, passId: randomUUID(), runId, projectRoot: repoRoot,
        block: stepKey, input, state: "running", sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom: null,
    }, null, 4));
    console.log(`task ${taskNumber} resumes at ${stepKey} on the next /tackle-tasks [${taskNumber}]`);
}
