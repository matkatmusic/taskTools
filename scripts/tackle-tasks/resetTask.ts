import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const taskNumber = Number(process.argv[2]);
if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    console.error("usage: node resetTask.ts <taskNumber>");
    process.exit(1);
}

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

try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoRoot, stdio: "pipe" }); } catch { /* not registered */ }
try { execSync(`git branch -D ${branchName}`, { cwd: repoRoot, stdio: "pipe" }); } catch { /* already gone */ }
if (existsSync(leasePath)) rmSync(leasePath);
execSync("git worktree prune", { cwd: repoRoot, stdio: "pipe" });

for (const f of [".git/taskTools-source.lock", ".git/taskTools-source.lock.mutation-guard"]) {
    const p = join(repoRoot, f);
    if (existsSync(p)) rmSync(p);
}
for (const entry of existsSync(join(repoRoot, ".taskTools", "runs")) ? readdirSync(join(repoRoot, ".taskTools", "runs")) : []) {
    rmSync(join(repoRoot, ".taskTools", "runs", entry, "packets"), { recursive: true, force: true });
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
    tasks.unshift(restored);
    writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
    writeFileSync(completedFile, JSON.stringify(completed, null, 2));
    console.log(`task ${taskNumber} restored to tasks.json; master reset to ${resetTarget}`);
} else {
    const { run, codexReviewNotes, planReviewCount, clarifyRequest, ...restored } = tasks[openIndex];
    tasks[openIndex] = restored;
    writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
    console.log(`task ${taskNumber} run state cleared`);
}
