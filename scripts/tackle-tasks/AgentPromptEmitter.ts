// Emits yellow-box prompts for tackle-tasks agent roles (read-only per greenBoxPolicy.ts); see workflow-only-context-injection.md §2/§6.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorktreeOccurrences, parseOccurrencePath, type WorktreeOccurrence } from "./occurrences.ts";
import { planReviewPrompt } from "./CodexReviewBodyEmitter.ts";
import { planPrompt } from "./PlannerBodyEmitter.ts";
import { implementPrompt } from "./ImplementBodyEmitter.ts";
import { reviewTestsPrompt } from "./CodexTestReviewBodyEmitter.ts";
import { fixConflictsPrompt } from "./FixConflictsBodyEmitter.ts";
import { loadPreparedTask, type PreparedTask } from "./preparedTask.ts";

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

// ---------------------------------------------------------------------------
// Shared prompt-building helpers.
// ---------------------------------------------------------------------------

const worktreePath = (t: PreparedTask, relativePath: string) => `${t.repoRoot.replace(/\/+$/, "")}/${relativePath}`;

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

export function fixSuitePrompt(checkoutPath: string, occurrenceId: string, testOutput: string, forbiddenPaths: string[], ownedSourcePaths: string[] = []): string {
    const layer = occurrenceId === "" ? "root" : occurrenceId;
    return fixCodebasePrompt(`The full suite for layer "${layer}"`, checkoutPath, testOutput, forbiddenPaths, ownedSourcePaths);
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

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// Saves a real run's prompt beside the generated one for diffing; idempotent, keeping this emitter read-only-safe per greenBoxPolicy.
function logEmittedPrompt(taskNumber: number, role: string, payload: AgentPromptEmitterPayload, prompt: string): void {
    const directory = join(payload.projectRoot, "plans/diagram/output renders", String(taskNumber), "runs", payload.runId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${role}.md`), prompt);
}

export function emitAgentPrompt(taskNumber: number, role: string, payload: AgentPromptEmitterPayload): string {
    const worktree = payload.worktree;
    const projectRoot = payload.projectRoot;
    switch (role) {
        case "plan":
            return planPrompt(loadPreparedTask(taskNumber, worktree, projectRoot));
        case "review-plan":
            return planReviewPrompt(loadPreparedTask(taskNumber, worktree, projectRoot));
        case "implement":
            return implementPrompt(
                loadPreparedTask(taskNumber, worktree, projectRoot),
                typeof payload.note === "string" ? payload.note : "",
                typeof payload.typecheckCommand === "string" ? payload.typecheckCommand : "npx tsc --noEmit",
                typeof payload.maxFixRounds === "number" ? payload.maxFixRounds : 3,
            );
        case "fix-conflicts":
            return fixConflictsPrompt(payload.checkoutPath as string);
        // The edit allowlist is the task's own ownership fence, so it is read here, never accepted from the caller.
        case "fix-suite":
            return fixSuitePrompt(
                payload.checkoutPath as string,
                typeof payload.occurrenceId === "string" ? payload.occurrenceId : "",
                typeof payload.testOutput === "string" ? payload.testOutput : "",
                Array.isArray(payload.forbiddenPaths) ? payload.forbiddenPaths as string[] : [],
                loadPreparedTask(taskNumber, worktree, projectRoot).files,
            );
        case "fix-tests":
            return fixTestsPrompt(
                payload.checkoutPath as string,
                typeof payload.occurrenceId === "string" ? payload.occurrenceId : "",
                typeof payload.testOutput === "string" ? payload.testOutput : "",
                Array.isArray(payload.forbiddenPaths) ? payload.forbiddenPaths as string[] : [],
                taskNumber,
                loadPreparedTask(taskNumber, worktree, projectRoot).files,
            );
        case "review-tests":
            return reviewTestsPrompt(loadPreparedTask(taskNumber, worktree, projectRoot));
        case "amend-tests":
            return amendTestsPrompt(
                loadPreparedTask(taskNumber, worktree, projectRoot),
                typeof payload.notes === "string" ? payload.notes : "",
                Array.isArray(payload.createdTestFiles) ? payload.createdTestFiles as string[] : [],
                Array.isArray(payload.testFiles) ? payload.testFiles as string[] : [],
            );
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

    try {
        const prompt = emitAgentPrompt(N, ROLE, PAYLOAD);
        logEmittedPrompt(N, ROLE, PAYLOAD, prompt);
        process.stdout.write(prompt);
    } catch (error) {
        fail(String((error as Error)?.message ?? error));
    }
}
