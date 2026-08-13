// Diagram rule 11: a mutating box whose result is lost is never blindly retried and never assumed
// failed. This module reads the world and decides whether the step already happened.
// plans/tackle-tasks-v1_5-plan.md Phase 8.
//
// Every check here is read-only, which is what makes reconciliation itself retryable. A "completed"
// verdict reconstructs the lost box's stdout in `result` so the workflow takes the correct edge
// without rerunning the mutation. "not-completed" is returned only where rerunning the step is
// idempotent from the observed state. "ambiguous" is the only path to run-failed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { validateArchivedRun, type ArchivedTaskRecord } from "../closeTasks.ts";
import { collectRetainedTaskArtifacts, findRecordedMergedCommit } from "../mergeTaskWorktrees.ts";
import {
    loadRepositoryManifest, readTaskWorktreeLeaseOwner, resolveTaskWorktreeConventionDirectory, taskWorktreeLeasePath,
} from "../prepareTasks.ts";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import { checkTaskWorktreeSafe } from "./checkTaskWorktreeSafe.ts";
import { taskBranchName, taskWorktreeCreateJournalPath, type TaskWorktreeCreateJournal } from "./createTaskWorktree.ts";
import { getGreenBoxCategory } from "./greenBoxPolicy.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { isNotesFileContained } from "./isTaskRunResumable.ts";
import { buildOccurrencePath, buildWorktreeOccurrences, getOccurrencesDeepestFirst } from "./occurrences.ts";
import { buildLockOwner, readSourceRepoLock } from "./sourceRepoLock.ts";
import { readTaskRunState, type TaskRunRecord, type TaskRunState } from "./taskRunState.ts";
import { GENERATED_ARTIFACT_PATTERNS, renderTaskBrief } from "./writeTaskBrief.ts";

export type ReconcileStatus = "completed" | "not-completed" | "ambiguous";

export type ReconcileStepOutput = {
    status: ReconcileStatus;
    result: Record<string, unknown> | null;
    note: string | null;
};

// `stepInput` is the exact stdin object the lost box received. Two handlers need one extra
// observation the workflow made before the call: applyPlanAmendments needs `revisionBefore`.
export type ReconcileStepInput = {
    script: string;
    stepId: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    stepInput: Record<string, unknown>;
};

function completed(result: Record<string, unknown>): ReconcileStepOutput {
    return { status: "completed", result, note: null };
}

function notCompleted(note: string): ReconcileStepOutput {
    return { status: "not-completed", result: null, note };
}

function ambiguous(note: string): ReconcileStepOutput {
    return { status: "ambiguous", result: null, note };
}

function git(checkoutPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", checkoutPath, ...args], { encoding: "utf8" }).trim();
}

function tryGit(checkoutPath: string, ...args: string[]): string | null {
    try {
        return git(checkoutPath, ...args);
    } catch {
        return null;
    }
}

function hasRef(checkoutPath: string, ref: string): boolean {
    return tryGit(checkoutPath, "rev-parse", "--verify", "--quiet", ref) !== null;
}

function isRebaseInProgress(checkoutPath: string): boolean {
    return ["rebase-merge", "rebase-apply"].some((name) => {
        const reported = tryGit(checkoutPath, "rev-parse", "--git-path", name);
        if (reported === null) return false;
        return existsSync(isAbsolute(reported) ? reported : join(checkoutPath, reported));
    });
}

function readStateOrNull(taskNumber: number, projectRoot: string): TaskRunState | null {
    try {
        return readTaskRunState(taskNumber, projectRoot);
    } catch {
        return null;
    }
}

function findRunRecord(state: TaskRunState, runId: string): TaskRunRecord | null {
    return state.history.find((run) => run.runId === runId) ?? null;
}

function physicalLeaseNames(worktreePath: string, runId: string): boolean {
    return readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath))?.runId === runId;
}

function readString(stepInput: Record<string, unknown>, field: string): string | null {
    const value = stepInput[field];
    return typeof value === "string" && value.length > 0 ? value : null;
}

// The handlers. One per row of the Phase 8 reconciliation table; every mutating workflow script
// in greenBoxPolicy has an entry here, which test_greenBoxPolicy_hasAReconciliationHandlerFor... asserts.
type Handler = (input: ReconcileStepInput) => ReconcileStepOutput;

function reconcileClaimTaskRun(input: ReconcileStepInput): ReconcileStepOutput {
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    if (state === null) return notCompleted("the task is not in tasks.json, so no claim is held");
    const newest = state.history[state.history.length - 1];
    if (state.active && newest?.runId === input.runId) {
        return completed({ status: "claimed", heldByRunId: null });
    }
    return notCompleted(`task ${input.taskNumber} is not active under ${input.runId}`);
}

// F1: a retained journal is the durable intent record from a call that died before it could
// finish or roll back itself. Deleting it (or removing the worktree/branch it owns) is a
// mutation, so this stays read-only: it only classifies whether a rerun of createTaskWorktree -
// which self-heals a retained journal it finds - is now proved safe. Never inferred from the
// conventional path alone: a journal must name this task/path/branch, and a physical lease
// naming a third run (neither the journal's run nor absent) makes rerunning unsafe (the real
// function would throw), so that is ambiguous, not not-completed. A journal naming a run other
// than the one this reconciliation call is for is equally unsafe to rerun for THIS run (the real
// function now refuses it too) - never adopted as this run's completion, never treated as safe to
// roll back either. Completion requires BOTH task state and the physical lease to name the
// journal's run; task state matching with no physical lease is an unproven inconsistency, not
// proof of a safe rerun.
function classifyRetainedCreateJournal(
    taskNumber: number, runId: string, branch: string, expectedWorktreePath: string, journalPath: string, state: TaskRunState,
): ReconcileStepOutput | null {
    let journal: TaskWorktreeCreateJournal;
    try {
        journal = JSON.parse(readFileSync(journalPath, "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        return ambiguous(`the retained creation journal at ${journalPath} does not parse`);
    }
    if (journal.taskNumber !== taskNumber || journal.worktreePath !== expectedWorktreePath || journal.branch !== branch) {
        return ambiguous(`the retained creation journal at ${journalPath} does not match task ${taskNumber}'s expected worktree/branch`);
    }
    const owner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(journal.worktreePath));
    if (owner !== null && owner.runId !== journal.runId) {
        return ambiguous(
            `the retained creation journal names run ${journal.runId} but the worktree lease is now held by ${owner.runId}`,
        );
    }
    if (journal.runId !== runId) {
        return ambiguous(`the retained creation journal names run ${journal.runId}, not the requested run ${runId}`);
    }
    const stateMatchesJournal = state.worktree === journal.worktreePath && state.leaseRunId === journal.runId;
    if (stateMatchesJournal && owner !== null) {
        return completed({ worktree: journal.worktreePath, branch: journal.branch });
    }
    if (stateMatchesJournal && owner === null) {
        return ambiguous(
            `task state names run ${journal.runId} for the retained creation journal, but no physical worktree lease exists`,
        );
    }
    return notCompleted("a retained creation journal is present; rerunning createTaskWorktree will recover it");
}

function reconcileCreateTaskWorktree(input: ReconcileStepInput): ReconcileStepOutput {
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    if (state === null) return ambiguous("the task is not in tasks.json, so the worktree record cannot be read");
    const branch = taskBranchName(input.taskNumber);
    const expectedWorktreePath = join(resolveTaskWorktreeConventionDirectory(input.projectRoot), branch);
    const journalVerdict = classifyRetainedCreateJournal(
        input.taskNumber, input.runId, branch, expectedWorktreePath, taskWorktreeCreateJournalPath(expectedWorktreePath), state,
    );
    if (journalVerdict !== null) return journalVerdict;

    const worktreePath = state.worktree;
    if (worktreePath === null || !existsSync(worktreePath)) {
        return notCompleted("no worktree is recorded on the task or the recorded path is gone");
    }
    if (!checkTaskWorktreeSafe(input.taskNumber, worktreePath).safe) {
        return notCompleted(`the worktree at ${worktreePath} is not structurally valid`);
    }
    if (state.leaseRunId !== input.runId || !physicalLeaseNames(worktreePath, input.runId)) {
        return notCompleted(`both lease records must name ${input.runId}`);
    }
    return completed({ worktree: worktreePath, branch });
}

function reconcileIsTaskRunResumable(input: ReconcileStepInput): ReconcileStepOutput {
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    if (state === null) return ambiguous("the task is not in tasks.json, so prior notes cannot be read");
    // F5: the original worktree path, not an inferred one - the mutation's containment contract
    // is only recomputed correctly against the exact path the lost box was given.
    const worktreePath = readString(input.stepInput, "worktreePath");
    if (worktreePath === null) return ambiguous("the step input carried no worktreePath");
    const endedRuns = state.history.filter((run) => run.endedAt !== null);
    const notesFile = endedRuns[endedRuns.length - 1]?.implementationNotesFile ?? null;
    // A false verdict writes nothing, so recomputing it is the whole reconciliation. The shared
    // predicate rejects a "../" escape, an absolute-outside path, a symlink escape and a
    // directory the same way the real isTaskRunResumable does.
    if (notesFile === null || !isNotesFileContained(worktreePath, notesFile)) {
        return completed({ resumable: false, implementationNotesFile: null, leaseEstablished: false });
    }
    if (state.leaseRunId !== input.runId || !physicalLeaseNames(worktreePath, input.runId)) {
        return notCompleted(`resumable work was found but the lease does not yet name ${input.runId}`);
    }
    return completed({ resumable: true, implementationNotesFile: notesFile, leaseEstablished: true });
}

function reconcileResetTaskWorktree(input: ReconcileStepInput): ReconcileStepOutput {
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    if (state === null) return ambiguous("the task is not in tasks.json, so the reset worktree cannot be read");
    const branch = taskBranchName(input.taskNumber);
    const worktreePath = state.worktree;
    if (worktreePath === null || !existsSync(worktreePath)) return notCompleted("no reset worktree exists");
    if (!checkTaskWorktreeSafe(input.taskNumber, worktreePath).safe) {
        return notCompleted(`the worktree at ${worktreePath} is not a fresh safe task branch`);
    }
    if (state.leaseRunId !== input.runId || !physicalLeaseNames(worktreePath, input.runId)) {
        return notCompleted(`both lease records must name ${input.runId}`);
    }
    const stale = buildWorktreeOccurrences(worktreePath, input.projectRoot).filter((occurrence) =>
        findRecordedMergedCommit(occurrence.sourceCheckoutPath, branch) !== null
        || hasRef(occurrence.sourceCheckoutPath, `refs/taskTools/merge-intents/${branch}`));
    if (stale.length > 0) {
        return notCompleted(`old merge persistence survives in ${stale.map((o) => o.occurrenceId || "root").join(", ")}`);
    }
    return completed({ worktree: worktreePath, branch });
}

function reconcileTaskDocs(input: ReconcileStepInput): ReconcileStepOutput {
    const worktreePath = readString(input.stepInput, "worktreePath");
    if (worktreePath === null) return ambiguous("the step input carried no worktreePath");
    const briefFile = join(worktreePath, "plans", `brief-${input.taskNumber}.md`);
    if (!existsSync(briefFile)) return notCompleted("the expected brief does not exist");
    if (readFileSync(briefFile, "utf8") !== renderTaskBrief(input.taskNumber, input.projectRoot)) {
        return notCompleted("the brief on disk does not match the brief this run would write");
    }
    const flagged = tryGit(worktreePath, "ls-files", "-v", "--", ...GENERATED_ARTIFACT_PATTERNS);
    if (flagged === null) return ambiguous("the worktree index could not be read");
    const unisolated = flagged.split("\n").filter((line) => line.length > 0 && !line.startsWith("S"));
    if (unisolated.length > 0) return notCompleted(`generated paths are still tracked: ${unisolated.join(", ")}`);
    return completed({ briefFile });
}

function reconcileAmendExitNotesIntoBrief(input: ReconcileStepInput): ReconcileStepOutput {
    const worktreePath = readString(input.stepInput, "worktreePath");
    if (worktreePath === null) return ambiguous("the step input carried no worktreePath");
    const briefFile = join(worktreePath, "plans", `brief-${input.taskNumber}.md`);
    if (!existsSync(briefFile)) return notCompleted("the brief does not exist yet");
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    if (state === null) return ambiguous("the task is not in tasks.json, so the intended runs cannot be listed");
    const previousRuns = state.active ? state.history.slice(0, -1) : state.history.slice();
    const intended = previousRuns.filter((run) => run.exitType !== null).reverse().slice(0, 3);
    if (intended.length === 0) return completed({ briefFile, runsAmended: 0 });
    const brief = readFileSync(briefFile, "utf8");
    const counts = intended.map((run) => brief.split(`## Previous run — ${run.startedAt} (runId ${run.runId})`).length - 1);
    if (counts.every((count) => count === 1)) return completed({ briefFile, runsAmended: intended.length });
    if (counts.every((count) => count === 0)) return notCompleted("no intended run heading is present");
    return ambiguous(`a partial or duplicated amendment is in the brief: heading counts ${counts.join(", ")}`);
}

// F10: `initialized` is not derivable from live state alone — a fully-populated worktree is
// indistinguishable between "this call populated them" and "they already were". The real box
// persists its exact answer before stdout; reconciliation only ever replays that receipt.
function reconcileInitTaskSubmodules(input: ReconcileStepInput): ReconcileStepOutput {
    const worktreePath = readString(input.stepInput, "worktreePath");
    if (worktreePath === null) return ambiguous("the step input carried no worktreePath");
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    const record = state === null ? null : findRunRecord(state, input.runId);
    if (record === null) return ambiguous(`no run record for ${input.runId}`);
    const receipt = record.stepResults?.find((entry) => entry.stepId === input.stepId && entry.script === "initTaskSubmodules");
    if (receipt !== undefined) return completed(receipt.result as Record<string, unknown>);
    // No receipt: the box never reached its durable write. initTaskSubmodules only ever
    // initializes uninitialized submodules, a naturally idempotent operation, so a rerun is safe.
    return notCompleted(`no initTaskSubmodules receipt for step "${input.stepId}" was found`);
}

function reconcileRecordImplementationNotes(input: ReconcileStepInput): ReconcileStepOutput {
    const worktreePath = readString(input.stepInput, "worktreePath");
    const intended = readString(input.stepInput, "implementationNotesFile");
    if (worktreePath === null) return ambiguous("the step input carried no worktreePath");
    if (intended === null) return ambiguous("the step input carried no implementationNotesFile");
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    const record = state === null ? null : findRunRecord(state, input.runId);
    if (record === null) return ambiguous(`no run record for ${input.runId}`);
    if (record.implementationNotesFile !== intended) return notCompleted("the run record names a different notes file");
    // F5: the record matching intended is not enough on its own - the real mutator only ever
    // wrote that string after this same containment check passed, so recompute it now rather
    // than trust the stored string blindly (a "../" escape, symlink escape, or a path deleted
    // after the mutation would otherwise be reconstructed as success).
    if (!isNotesFileContained(worktreePath, intended)) {
        return ambiguous(`"${intended}" no longer resolves to a contained regular file inside ${worktreePath}`);
    }
    return completed({ implementationNotesFile: intended });
}

function reconcileApplyPlanAmendments(input: ReconcileStepInput): ReconcileStepOutput {
    const planFilePath = readString(input.stepInput, "planFilePath");
    const revisionBefore = input.stepInput.revisionBefore;
    if (planFilePath === null) return ambiguous("the step input carried no planFilePath");
    if (typeof revisionBefore !== "number") {
        return ambiguous("the workflow did not record the plan revision it read before the call");
    }
    if (!existsSync(planFilePath)) return ambiguous("the plan file is gone");
    let revision: unknown;
    try {
        revision = (JSON.parse(readFileSync(planFilePath, "utf8")) as { revision?: unknown }).revision;
    } catch {
        return ambiguous("the plan file does not parse");
    }
    if (typeof revision !== "number") return ambiguous("the plan file has no numeric revision");
    if (revision > revisionBefore) return completed({ status: "applied", revision, problem: null });
    return notCompleted(`the plan revision is still ${revision}`);
}

function reconcileCommitTaskWork(input: ReconcileStepInput): ReconcileStepOutput {
    const worktreePath = readString(input.stepInput, "worktreePath");
    const rootSourceBranch = readString(input.stepInput, "rootSourceBranch");
    if (worktreePath === null || rootSourceBranch === null) {
        return ambiguous("the step input carried no worktreePath or rootSourceBranch");
    }
    if (!existsSync(worktreePath)) return ambiguous("the worktree is gone, so its layers cannot be read");
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    const record = state === null ? null : findRunRecord(state, input.runId);
    if (record === null) return ambiguous(`no run record for ${input.runId}`);
    const occurrences = getOccurrencesDeepestFirst(worktreePath, input.projectRoot, rootSourceBranch);
    // commitTaskWork skips a layer that is already clean, so a layer with no record entry proves
    // nothing. Uncommitted work is the only state that proves the box did not finish.
    const dirty = occurrences.filter((occurrence) => tryGit(occurrence.checkoutPath, "status", "--porcelain") !== "");
    if (dirty.length > 0) {
        return notCompleted(`${dirty.map((o) => o.occurrenceId || "root").join(", ")} still has uncommitted work`);
    }
    // F2: scope strictly to this logical step's own commits. A prior step's commits still
    // sitting unstranded at HEAD must never be handed back as proof that a LATER step finished;
    // rerunning commitTaskWork is what recovers a landed-but-unrecorded commit, not this check.
    // A commit recorded with no stepId (or a different one) never counts toward this step -
    // there is no legacy wildcard.
    const derived = record.commits.filter((commit) => commit.kind !== "merge" && commit.stepId === input.stepId);
    if (derived.length === 0) return notCompleted(`the run record holds no commit for step "${input.stepId}"`);
    // A derived commit that is no longer at its layer's HEAD is the repairable partial state:
    // rerunning commitTaskWork appends the existing hash rather than creating a second commit.
    const stranded = derived.filter((commit) => {
        const occurrence = occurrences.find((candidate) => candidate.occurrenceId === commit.occurrenceId);
        return occurrence === undefined || tryGit(occurrence.checkoutPath, "rev-parse", "HEAD") !== commit.hash;
    });
    if (stranded.length > 0) {
        return notCompleted(`${stranded.map((c) => c.occurrenceId || "root").join(", ")} recorded a commit that is not at HEAD`);
    }
    return completed({ commits: derived });
}

function reconcileRunTaskTests(input: ReconcileStepInput): ReconcileStepOutput {
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    const stored = state === null ? null : findRunRecord(state, input.runId)?.taskTests ?? null;
    if (stored === null || stored.stepId !== input.stepId) return notCompleted("no stored decision for this stepId");
    return completed({
        stepId: stored.stepId, passed: stored.passed, testFiles: stored.testFiles,
        createdTestFiles: stored.createdTestFiles, deletedTestFiles: stored.deletedTestFiles,
        missingTests: stored.missingTests, output: stored.output,
    });
}

function reconcileRunFullSuite(input: ReconcileStepInput): ReconcileStepOutput {
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    const stored = state === null ? null : findRunRecord(state, input.runId)?.fullSuite ?? null;
    if (stored === null || stored.stepId !== input.stepId) return notCompleted("no stored decision for this stepId");
    return completed({
        stepId: stored.stepId, passed: stored.passed, layers: stored.layers, output: stored.output,
    });
}

// F3: a step-result receipt is written for EVERY returned outcome of rebaseTaskWorktree /
// advanceTaskRebase (clean finish, conflict, or test failure), not only a clean finish. When its
// live-state evidence still matches, it is replayed exactly — including a live in-progress rebase
// this exact step produced, which must never be mistaken for proof that rerunning the mutation is
// safe. With no matching receipt, a live rebase is genuinely undecidable: the box may have died
// before it ever returned, or it may have returned a conflict and died before appending the
// receipt. Those two histories leave identical state, and rerunning the second one repeats a
// mutation against a live partial rebase, so that case is ambiguous. Only a clean idle worktree
// with no receipt proves nothing is left to reconstruct and a rerun is idempotent.
function reconcileRebase(input: ReconcileStepInput, forAdvance: boolean): ReconcileStepOutput {
    const worktreePath = readString(input.stepInput, "worktreePath");
    const rootSourceBranch = readString(input.stepInput, "rootSourceBranch");
    if (worktreePath === null || rootSourceBranch === null) {
        return ambiguous("the step input carried no worktreePath or rootSourceBranch");
    }
    if (!existsSync(worktreePath)) return ambiguous("the worktree is gone, so its layers cannot be read");

    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    const record = state === null ? null : findRunRecord(state, input.runId);
    if (record === null) return ambiguous(`no run record for ${input.runId}`);

    const script = forAdvance ? "advanceTaskRebase" : "rebaseTaskWorktree";
    const receipt = record.stepResults?.find((entry) => entry.stepId === input.stepId && entry.script === script);
    if (receipt !== undefined) {
        const worktreeOccurrences = buildWorktreeOccurrences(worktreePath, input.projectRoot);
        const currentOccurrenceIds = worktreeOccurrences.map((occurrence) => occurrence.occurrenceId).sort();
        const occurrenceIdsMatch = JSON.stringify(currentOccurrenceIds) === JSON.stringify(receipt.occurrenceIds ?? []);
        const headsMatch = (receipt.worktreeHeads ?? []).every(({ occurrenceId, head }) => {
            const occurrence = worktreeOccurrences.find((candidate) => candidate.occurrenceId === occurrenceId);
            return occurrence !== undefined && tryGit(occurrence.worktreeCheckoutPath, "rev-parse", "HEAD") === head;
        });
        if (occurrenceIdsMatch && headsMatch) return completed(receipt.result as Record<string, unknown>);
    }

    const occurrences = getOccurrencesDeepestFirst(worktreePath, input.projectRoot, rootSourceBranch);
    const live = occurrences.filter((occurrence) => isRebaseInProgress(occurrence.checkoutPath));
    if (live.length > 0) {
        return ambiguous(`a rebase is still in progress in ${live.map((o) => o.occurrenceId || "root").join(", ")} and no receipt for step "${input.stepId}" proves what it returned`);
    }
    return notCompleted(`no rebase receipt for step "${input.stepId}" was found`);
}

function reconcileMergeTaskWorktree(input: ReconcileStepInput): ReconcileStepOutput {
    const worktreePath = readString(input.stepInput, "worktreePath");
    if (worktreePath === null) return ambiguous("the step input carried no worktreePath");
    if (!existsSync(worktreePath)) return ambiguous("the worktree is gone, so its occurrences cannot be listed");
    const branch = taskBranchName(input.taskNumber);
    const occurrences = buildWorktreeOccurrences(worktreePath, input.projectRoot);
    const commits = occurrences.map((occurrence) => ({
        occurrenceId: occurrence.occurrenceId,
        hash: findRecordedMergedCommit(occurrence.sourceCheckoutPath, branch),
        kind: "merge" as const,
    }));
    const unmerged = commits.filter((commit) => commit.hash === null);
    if (unmerged.length === commits.length) return notCompleted("no occurrence has a recorded merged commit");
    if (unmerged.length > 0) {
        return ambiguous(`only some occurrences merged; ${unmerged.map((c) => c.occurrenceId || "root").join(", ")} did not`);
    }
    return completed({ merged: true, commits, failureReason: null });
}

function reconcileRecordMergeCommits(input: ReconcileStepInput): ReconcileStepOutput {
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    const record = state === null ? null : findRunRecord(state, input.runId);
    if (record === null) return ambiguous(`no run record for ${input.runId}`);
    const merged = record.commits.filter((commit) => commit.kind === "merge");
    if (merged.length === 0) return notCompleted("the run record holds no merge-kind commits");
    return completed({ commits: merged });
}

function reconcileRecordTaskModifiedFiles(input: ReconcileStepInput): ReconcileStepOutput {
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    const record = state === null ? null : findRunRecord(state, input.runId);
    if (record === null) return ambiguous(`no run record for ${input.runId}`);
    const worktreePath = readString(input.stepInput, "worktree");
    const sourceBranch = readString(input.stepInput, "sourceBranch");
    if (worktreePath === null || !existsSync(worktreePath)) {
        // After clean-up the paths cannot be recomputed; a retained non-empty record is authoritative.
        if (record.modifiedFiles.length > 0) return completed({ modifiedFiles: record.modifiedFiles });
        return ambiguous("the worktree is gone and the record is empty, so nothing distinguishes the two cases");
    }
    if (sourceBranch === null) return ambiguous("the step input carried no sourceBranch");
    const recomputed = getOccurrencesDeepestFirst(worktreePath, input.projectRoot, sourceBranch)
        .flatMap((occurrence) => {
            const changed = tryGit(occurrence.checkoutPath, "diff", "--name-only", `${occurrence.baseRef}...HEAD`);
            return (changed ?? "").split("\n").filter(Boolean)
                .map((relativePath) => buildOccurrencePath(occurrence.occurrenceId, relativePath));
        });
    if (JSON.stringify(record.modifiedFiles) !== JSON.stringify(recomputed)) {
        return notCompleted("the stored occurrence paths differ from the recomputed paths");
    }
    return completed({ modifiedFiles: record.modifiedFiles });
}

function reconcileCleanupTaskWorktree(input: ReconcileStepInput): ReconcileStepOutput {
    const worktreePath = readString(input.stepInput, "worktreePath");
    if (worktreePath === null) return ambiguous("the step input carried no worktreePath");
    const branch = taskBranchName(input.taskNumber);
    // The same reader clean-up itself uses, so both agree about every submodule layer, not just root.
    const sourceSubmodules = loadRepositoryManifest(input.projectRoot).occurrences
        .filter((occurrence) => occurrence.occurrenceId !== "")
        .map((occurrence) => ({ checkoutPath: occurrence.checkoutPath, depth: occurrence.depth }));
    const retained = collectRetainedTaskArtifacts({
        worktreePath, leasePath: taskWorktreeLeasePath(worktreePath),
        mainRepoRoot: input.projectRoot, branch, sourceSubmodules,
    });
    if (readSourceRepoLock(input.projectRoot)?.owner === buildLockOwner(input.runId, input.taskNumber)) {
        retained.push("source lock");
    }
    if (retained.length > 0) return notCompleted(`clean-up left ${retained.join(", ")} in place`);
    return completed({ removed: true, retainedArtifacts: [] });
}

function reconcileWriteTaskExitNotes(input: ReconcileStepInput): ReconcileStepOutput {
    const exitType = readString(input.stepInput, "exitType");
    const exitNote = readString(input.stepInput, "exitNote");
    if (exitType === null) return ambiguous("the step input carried no exitType");
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    const record = state === null ? null : findRunRecord(state, input.runId);
    if (record === null) return ambiguous(`no run record for ${input.runId}`);
    if (record.exitType !== exitType || record.exitNote !== exitNote) {
        return notCompleted(`the run record still reads exitType ${record.exitType ?? "null"}`);
    }
    return completed({ exitType: record.exitType, exitNote: record.exitNote });
}

function reconcileMarkTaskInactive(input: ReconcileStepInput): ReconcileStepOutput {
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    const record = state === null ? null : findRunRecord(state, input.runId);
    if (record === null) return ambiguous(`no run record for ${input.runId}`);
    if (state?.active !== false || record.endedAt === null) return notCompleted("the run has not been ended");
    return completed({ active: false, endedAt: record.endedAt });
}

// F10: leaseReleased/lockReleased are not derivable from live state alone once this run no
// longer holds them — an absent lock/lease looks identical whether this call released it or
// never held it. The real box persists its exact answer before stdout; reconciliation only ever
// replays that receipt, and is honest (`ambiguous`) rather than guessing when there is none.
function reconcileReleaseTaskRunHolds(input: ReconcileStepInput): ReconcileStepOutput {
    const state = readStateOrNull(input.taskNumber, input.projectRoot);
    const record = state === null ? null : findRunRecord(state, input.runId);
    if (record === null) return ambiguous(`no run record for ${input.runId}`);
    const receipt = record.stepResults?.find((entry) => entry.stepId === input.stepId && entry.script === "releaseTaskRunHolds");
    if (receipt !== undefined) return completed(receipt.result as Record<string, unknown>);

    const lockHeld = readSourceRepoLock(input.projectRoot)?.owner === buildLockOwner(input.runId, input.taskNumber);
    if (lockHeld) return notCompleted("this run still owns the source lock");
    // No receipt and this run holds nothing more to release: releaseTaskRunHolds only ever
    // touches holds it owns, so a rerun is idempotent and safe.
    return notCompleted(`no releaseTaskRunHolds receipt for step "${input.stepId}" was found`);
}

// F/a4-4: once close succeeds the task is gone from tasks.json, so readStateOrNull() can never
// recover the run that produced an archive - the archive's own retained `run.history` is the
// only durable evidence left. validateArchivedRun (shared with closeTasks.ts's closeTaskRun so
// the two cannot drift) proves the archive names this exact runId, closure note, and
// chronological commit hashes before either verdict below is returned.
function reconcileCloseTaskRun(input: ReconcileStepInput): ReconcileStepOutput {
    const closureNote = readString(input.stepInput, "closureNote");
    if (closureNote === null) return ambiguous("the step input carried no closureNote");
    const { tasksPath, completedTasksPath } = resolveTaskFiles(input.projectRoot);
    const openTasks = readTaskFile(tasksPath) as { taskNumber: number }[];
    const completedTasks = readTaskFile(completedTasksPath) as ArchivedTaskRecord[];
    const stillOpen = openTasks.some((task) => task.taskNumber === input.taskNumber);
    const archived = completedTasks.find((task) => task.taskNumber === input.taskNumber);
    if (archived === undefined) {
        if (stillOpen) return notCompleted("the task is still only in tasks.json");
        return ambiguous(`task ${input.taskNumber} is in neither task file`);
    }
    const endedRun = validateArchivedRun(archived, input.runId, closureNote);
    if (endedRun === null) {
        return ambiguous(`the archive for task ${input.taskNumber} does not carry run ${input.runId}'s durable record`);
    }
    // [a4 3]: present in both files, proved same-run, is a half-finished archive - rerunning
    // idempotent closeTasks upserts the archive and finishes the removal from tasks.json.
    if (stillOpen) return notCompleted("the archive is present in both task files");
    // F10: `unblocked` cannot be recomputed after the fact - the blockedBy entries it removed are
    // gone. closeTaskRun persists its exact real result into the archived record's run.history
    // before stdout; only that receipt is ever reproduced. No receipt is honest ambiguity, never
    // an invented empty array.
    const receipt = endedRun.stepResults?.find((entry) => entry.stepId === input.stepId && entry.script === "closeTaskRun");
    if (receipt !== undefined) return completed(receipt.result as Record<string, unknown>);
    return ambiguous(`the archive for task ${input.taskNumber} carries no closeTaskRun receipt for step "${input.stepId}"`);
}

const HANDLERS: Record<string, Handler> = {
    advanceTaskRebase: (input) => reconcileRebase(input, true),
    amendExitNotesIntoBrief: reconcileAmendExitNotesIntoBrief,
    applyPlanAmendments: reconcileApplyPlanAmendments,
    claimTaskRun: reconcileClaimTaskRun,
    cleanupTaskWorktree: reconcileCleanupTaskWorktree,
    closeTaskRun: reconcileCloseTaskRun,
    commitTaskWork: reconcileCommitTaskWork,
    createTaskWorktree: reconcileCreateTaskWorktree,
    generateTaskDocs: reconcileTaskDocs,
    initTaskSubmodules: reconcileInitTaskSubmodules,
    isTaskRunResumable: reconcileIsTaskRunResumable,
    markTaskInactive: reconcileMarkTaskInactive,
    mergeTaskWorktree: reconcileMergeTaskWorktree,
    rebaseTaskWorktree: (input) => reconcileRebase(input, false),
    recordImplementationNotes: reconcileRecordImplementationNotes,
    recordMergeCommits: reconcileRecordMergeCommits,
    recordTaskModifiedFiles: reconcileRecordTaskModifiedFiles,
    releaseTaskRunHolds: reconcileReleaseTaskRunHolds,
    resetTaskWorktree: reconcileResetTaskWorktree,
    runFullSuite: reconcileRunFullSuite,
    runTaskTests: reconcileRunTaskTests,
    updateTaskDocs: reconcileTaskDocs,
    writeTaskExitNotes: reconcileWriteTaskExitNotes,
};

export function getReconciliationHandlerNames(): string[] {
    return Object.keys(HANDLERS).sort();
}

export function reconcileStep(input: ReconcileStepInput): ReconcileStepOutput {
    requireAbsolutePath("projectRoot", input.projectRoot);
    // A read-only box is retried, never reconciled; asking for one is a workflow bug, not a verdict.
    if (getGreenBoxCategory(input.script) !== "mutating") {
        throw new Error(`"${input.script}" is not a mutating workflow script`);
    }
    const handler = HANDLERS[input.script];
    if (handler === undefined) throw new Error(`no reconciliation handler for "${input.script}"`);
    return handler(input);
}

if (process.argv[1]?.endsWith("reconcileStep.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as ReconcileStepInput;
    const output = reconcileStep(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
