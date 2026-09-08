// Behavioral checks for scripts/steps/pipeline-rebase/FIX_CONFLICTS.ts. Ported from tests/FixConflictsBodyEmitter.test.ts, against the new packet contract.  Run: node --test tests/steps/pipeline-rebase/FIX_CONFLICTS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-rebase/FIX_CONFLICTS.ts";
import type { RebasePacket } from "../../../scripts/steps/pipeline-rebase/packet.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";
import { claimTask } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../../scripts/tackle-tasks/sourceRepoLock.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-rebase/FIX_CONFLICTS.template.json");

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

// A repository stopped mid-merge on a real unmerged path, so the box's git query finds it.
function makeConflictedRepo(fileName = "thing.ts"): string {
    const repo = mkdtempSync(join(tmpdir(), "fix-conflicts-step-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, fileName), "one\n");
    git(repo, "add", fileName);
    git(repo, "commit", "--quiet", "-m", "base");
    git(repo, "checkout", "--quiet", "-b", "other");
    writeFileSync(join(repo, fileName), "two\n");
    git(repo, "commit", "--quiet", "-am", "other side");
    git(repo, "checkout", "--quiet", "main");
    writeFileSync(join(repo, fileName), "three\n");
    git(repo, "commit", "--quiet", "-am", "main side");
    try {
        git(repo, "merge", "other");
    } catch {
        // A conflicting merge exits nonzero; that stopped state is exactly the fixture.
    }
    mkdirSync(join(repo, ".git"), { recursive: true });
    return repo;
}

function seedTaskAndClaimAndLock(projectRoot: string, taskNumber: number, runId: string): void {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
    const lockOutcome = acquireSourceRepoLock(projectRoot, buildLockOwner(runId, taskNumber));
    assert.equal(lockOutcome.status, "acquired");
}

function packet(projectRoot: string, checkoutPath: string, taskNumber: number, runId: string): RebasePacket {
    return {
        box: "ARE_2_CONFLICT_FIXES_DONE", scriptSignal: "continue", projectRoot, worktreePath: checkoutPath,
        taskNumber, runId, stepId: "step-1", rootSourceBranch: "main", landedOccurrenceIds: [],
        suiteFixAttempts: 0, conflicted: true, stoppedOccurrenceId: "", stoppedCheckoutPath: checkoutPath,
        conflictedFilePaths: [], finished: false, failureReason: "", exitType: "", exitNote: "",
    };
}

test("test_FIX_CONFLICTS_printsAPromptNamingTheConflictedPathFromTheStoppedCheckout", () => {
    const repo = makeConflictedRepo("conflicted.ts");
    seedTaskAndClaimAndLock(repo, 1, "run-1");

    const output = main(JSON.stringify(packet(repo, repo, 1, "run-1")));

    assert.equal(output.box, "FIX_CONFLICTS");
    assert.equal(output.scriptSignal, "prompt");
    const promptFileContents = readFileSync(join(repo, "plans", "FIX_CONFLICTS.prompt.md"), "utf8");
    assert.ok(promptFileContents.includes(`${repo}/conflicted.ts`), "prompt is missing the conflicted path");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_FIX_CONFLICTS_throwsWhenTheStoppedCheckoutHasNothingUnmerged", () => {
    const repo = mkdtempSync(join(tmpdir(), "fix-conflicts-step-clean-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    mkdirSync(join(repo, ".git"), { recursive: true });
    seedTaskAndClaimAndLock(repo, 2, "run-2");

    assert.throws(() => main(JSON.stringify(packet(repo, repo, 2, "run-2"))), /no unmerged paths/);
});
