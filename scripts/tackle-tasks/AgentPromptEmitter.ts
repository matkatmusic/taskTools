// Emits yellow-box prompts for tackle-tasks agent roles (read-only per greenBoxPolicy.ts); see workflow-only-context-injection.md §2/§6.
import { readFileSync } from "node:fs";
import { planReviewPrompt } from "./CodexReviewBodyEmitter.ts";
import { planPrompt, type PlanPromptExtra } from "./PlannerBodyEmitter.ts";
import { implementPrompt, type ImplementPromptExtra } from "./ImplementBodyEmitter.ts";
import type { PlanReview } from "./recordPlanReview.ts";
import type { TestReview } from "./decideTestReview.ts";
import { reviewTestsPrompt } from "./CodexTestReviewBodyEmitter.ts";
import { fixConflictsPrompt } from "./FixConflictsBodyEmitter.ts";
import { suiteFixPrompt } from "./SuiteFixBodyEmitter.ts";
import { finishRunPrompt } from "./FinishRunBodyEmitter.ts";
import { lockSourceRepoPrompt } from "./LockSourceRepoBodyEmitter.ts";
import { loadPreparedTask, type PreparedTask } from "./preparedTask.ts";
import { logStepOutput } from "./logStepOutput.ts";

export { loadPreparedTask, type PreparedTask } from "./preparedTask.ts";

function readStdin(): string {
    try {
        return readFileSync(0, "utf8");
    } catch {
        return "";
    }
}

function fail(problem: string): never {
    process.stderr.write(`AgentPromptEmitter: ${problem}\n`);
    process.exit(1);
}

export type AgentPromptEmitterPayload = {
    worktree: string;
    projectRoot: string;
    sourceBranch: string;
    runId: string;
    [key: string]: unknown;
};

/* Retired: the v1.5 diagrams replaced these agent boxes with green script boxes, so nothing dispatches them.

// ---------------------------------------------------------------------------
// fix-suite / fix-tests — from rebaseFixBrief, minus test-editing and self-commit. Edits source only, never tests (diagram rule 4).
// ---------------------------------------------------------------------------

function fixCodebasePrompt(subject: string, checkoutPath: string, testOutput: string, forbiddenPaths: string[], ownedSourcePaths: string[]): string {
    return `SUBJECT (see DATA below) is RED, in CHECKOUT_PATH (see DATA below). Fix the cause.

Carry out every step below, in order, from top to bottom.
A line reading \`return {...}\` means stop and report exactly those fields.

You may READ anything, anywhere in the tree. You may EDIT ONLY the paths listed in
OWNED_SOURCE_PATHS below, relative to CHECKOUT_PATH — never the test itself, and never
any other path, even source code that looks related. The paths listed in FORBIDDEN_PATHS
below sit on disk under CHECKOUT_PATH but belong to OTHER layers (separate occurrences)
and are out of scope even though they sit under CHECKOUT_PATH — do not edit anything
inside them.

fix the cause of the failure described in FAILURE_OUTPUT below, editing only the paths
in OWNED_SOURCE_PATHS

if fixing the cause requires editing anything outside OWNED_SOURCE_PATHS:
    make no edit and return {fixed: false}

leave your fix uncommitted — "commit if needed" stages and commits every touched
layer next; do not stage or commit anything yourself

if the fix addresses every failure in FAILURE_OUTPUT:
    return {fixed: true}
else:
    return {fixed: false}

You are forbidden to weaken, delete, or stub out a test or the code it covers
to make the failure disappear; to edit a test file at all; to edit any path
outside OWNED_SOURCE_PATHS, or inside a layer listed in FORBIDDEN_PATHS; to
force-push or hard-reset anything you did not create; or to stage or commit
anything yourself.

---- DATA ----
SUBJECT = ${subject}
CHECKOUT_PATH = ${checkoutPath}
OWNED_SOURCE_PATHS (the complete edit allowlist, relative to CHECKOUT_PATH) =
${ownedSourcePaths.length === 0 ? "  (none)" : ownedSourcePaths.map((p) => `  - ${p}`).join("\n")}
FORBIDDEN_PATHS (other layers, out of scope even though on disk under CHECKOUT_PATH) =
${forbiddenPaths.length === 0 ? "(none)" : forbiddenPaths.join(", ")}
FAILURE_OUTPUT (from the test run) =
${testOutput}`;
}

export function fixTestsPrompt(checkoutPath: string, occurrenceId: string, testOutput: string, forbiddenPaths: string[], taskNumber: number, ownedSourcePaths: string[] = []): string {
    const layer = occurrenceId === "" ? "root" : occurrenceId;
    return fixCodebasePrompt(`The tests for task #${taskNumber} in layer "${layer}"`, checkoutPath, testOutput, forbiddenPaths, ownedSourcePaths);
}

// ---------------------------------------------------------------------------
// amend-tests — from applyFeedbackBrief, retargeted at tests. Edits own tests freely; pre-existing ones only if broken/empty (rule 3).
// ---------------------------------------------------------------------------

// Resolves an occurrence-tagged test path (e.g. "child::tests/child.test.ts") to an absolute path in the matching submodule checkout.
function resolveTestFilePath(t: PreparedTask, taggedPath: string, nonRootOccurrences: () => WorktreeOccurrence[]): string {
    const { occurrenceId, relativePath } = parseOccurrencePath(taggedPath);
    if (occurrenceId === "") return worktreePath(t, relativePath);
    const occurrence = nonRootOccurrences().find((o) => o.occurrenceId === occurrenceId);
    if (!occurrence) fail(`amend-tests: no occurrence "${occurrenceId}" found for test file "${taggedPath}"`);
    return join(occurrence.worktreeCheckoutPath, relativePath);
}

export function amendTestsPrompt(t: PreparedTask, notes: string, createdTestFiles: string[], testFiles: string[]): string {
    // testFiles is every changed test; createdTestFiles is a subset. Derive pre-existing here, don't trust the caller subtracted it.
    const preExistingTestFiles = testFiles.filter((f) => !createdTestFiles.includes(f));
    let cachedOccurrences: WorktreeOccurrence[] | null = null;
    const nonRootOccurrences = () => cachedOccurrences ??= buildWorktreeOccurrences(t.repoRoot, t.taskStateRoot);
    const formatTestFiles = (files: string[]) => files.length === 0
        ? "  (none)"
        : files.map((f) => `  - ${f} => ${resolveTestFilePath(t, f, nonRootOccurrences)}`).join("\n");

    return `Apply test-review feedback, given in REVIEWER_NOTES below.

Files you created in this task's own worktree are listed in CREATED_TEST_FILES below,
and you may freely edit them.

Pre-existing test files this task modified, but did not create, are listed in TEST_FILES
below — the diagram's rule that a test not created in this task's worktree may only be
changed when it is broken or asserts nothing applies to every one of these, and to no
other file.

Read TEST_REVIEW_FILE (see DATA below), then edit only the files listed in
CREATED_TEST_FILES and TEST_FILES below, changing exactly what REVIEWER_NOTES calls for.
Never edit a source file, the brief, or the plan, and never edit a pre-existing test file
for any reason other than it being broken or asserting nothing.

Leave your edits uncommitted — "commit if needed" stages and commits every touched
layer next; do not stage or commit anything yourself.

If there is nothing to apply, make no edits and return amended false.

Return {amended: true} once you have made the edits, or {amended: false} if there was nothing to apply.

You are forbidden to edit any file other than the ones listed in CREATED_TEST_FILES and
TEST_FILES; to change a pre-existing test file except to fix it when it is broken or
asserts nothing; or to stage or commit anything yourself.

---- DATA ----
TEST_REVIEW_FILE = ${t.testReviewFile}
CREATED_TEST_FILES (freely editable) =
${formatTestFiles(createdTestFiles)}
TEST_FILES (pre-existing, broken-or-empty exception only) =
${formatTestFiles(preExistingTestFiles)}
REVIEWER_NOTES =
${notes}`;
}

*/

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// Maps a role to its diagram box, for the run log. "finish-run" has no single box.
const ROLE_TO_BOX_ID: Record<string, string> = {
    "plan": "PLAN_THE_TASK",
    "review-plan": "CODEX_REVIEWS_PLAN",
    "implement": "IMPLEMENT_TASK",
    "fix-conflicts": "FIX_CONFLICTS",
    "fix-suite": "FIX_THE_CODEBASE_FOR_SUITE",
    "review-tests": "CODEX_REVIEWS_TESTS",
    "lock-source-repo": "LOCK_SOURCE_REPO",
};

const EMIT_AGENT_PROMPT_SOURCE = "scripts/tackle-tasks/AgentPromptEmitter.ts:171: emitAgentPrompt";

export function emitAgentPrompt(taskNumber: number, role: string, payload: AgentPromptEmitterPayload): string {
    const worktree = payload.worktree;
    const projectRoot = payload.projectRoot;
    switch (role) {
        case "plan": {
            const planExtra: PlanPromptExtra = {
                clarifyRequest: typeof payload.clarifyRequest === "string" ? payload.clarifyRequest : undefined,
                planReview: payload.planReview as PlanReview | undefined,
                updateDocs: payload.updateDocs === true ? true : undefined,
            };
            return planPrompt(loadPreparedTask(taskNumber, worktree, projectRoot), planExtra);
        }
        case "review-plan":
            return planReviewPrompt(loadPreparedTask(taskNumber, worktree, projectRoot));
        case "implement": {
            const implementExtra: ImplementPromptExtra = {
                amendFailingTests: payload.amendFailingTests === true ? true : undefined,
                testReview: payload.testReview as TestReview | undefined,
            };
            return implementPrompt(
                loadPreparedTask(taskNumber, worktree, projectRoot),
                typeof payload.typecheckCommand === "string" ? payload.typecheckCommand : "npx tsc --noEmit",
                typeof payload.maxFixRounds === "number" ? payload.maxFixRounds : 3,
                payload.runId,
                payload.sourceBranch,
                implementExtra,
            );
        }
        case "fix-conflicts":
            return fixConflictsPrompt(payload.checkoutPath as string, taskNumber, projectRoot, payload.runId, payload.sourceBranch);
        case "fix-suite":
            return suiteFixPrompt(loadPreparedTask(taskNumber, worktree, projectRoot), payload.runId, payload.sourceBranch);
        case "review-tests":
            return reviewTestsPrompt(loadPreparedTask(taskNumber, worktree, projectRoot), payload.sourceBranch);
        // The lock box runs as one script, so this prompt carries no task brief.
        case "lock-source-repo":
            return lockSourceRepoPrompt({ taskNumber, runId: payload.runId, projectRoot });
        // The exit tails run as one script, so this prompt carries no task brief.
        case "finish-run":
            return finishRunPrompt({
                taskNumber,
                runId: payload.runId,
                projectRoot,
                worktree,
                sourceBranch: payload.sourceBranch,
                exitType: payload.exitType as string,
                exitNote: payload.exitNote as string,
            });
        default:
            throw new Error(`unknown role "${role}"`);
    }
}

if (process.argv[1]?.endsWith("AgentPromptEmitter.ts")) {
    const N = Number(process.argv[2]);
    const ROLE = process.argv[3];
    if (!Number.isInteger(N)) fail(`invalid task number: ${process.argv[2]}`);
    if (!ROLE) fail("no role given");

    const payloadText = readStdin();
    const PAYLOAD: AgentPromptEmitterPayload = payloadText ? JSON.parse(payloadText) : {};
    if (!PAYLOAD.worktree) fail('payload missing "worktree"');
    if (!PAYLOAD.projectRoot) fail('payload missing "projectRoot"');
    if (!PAYLOAD.sourceBranch) fail('payload missing "sourceBranch"');
    if (!PAYLOAD.runId) fail('payload missing "runId"');

    const identity = { projectRoot: PAYLOAD.projectRoot, taskNumber: N, runId: PAYLOAD.runId };
    const boxId = ROLE_TO_BOX_ID[ROLE] ?? ROLE;
    const command = `node ${process.argv[1]} ${N} ${ROLE} <<'TTPAYLOAD'\n${payloadText}\nTTPAYLOAD`;

    try {
        const prompt = emitAgentPrompt(N, ROLE, PAYLOAD);
        logStepOutput(identity, {
            boxId,
            source: EMIT_AGENT_PROMPT_SOURCE,
            input: PAYLOAD,
            command,
            commandOutput: prompt,
            output: prompt,
        });
        process.stdout.write(prompt);
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logStepOutput(identity, {
            boxId,
            source: EMIT_AGENT_PROMPT_SOURCE,
            input: PAYLOAD,
            command,
            commandOutput: message,
            output: { error: message },
        });
        fail(message);
    }
}
