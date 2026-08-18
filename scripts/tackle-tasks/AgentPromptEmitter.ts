// Emits yellow-box prompts for tackle-tasks agent roles (read-only per greenBoxPolicy.ts); see workflow-only-context-injection.md §2/§6.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorktreeOccurrences, parseOccurrencePath, type WorktreeOccurrence } from "./occurrences.ts";
import { planPrompt } from "./PlannerBodyEmitter.ts";
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

const TDD_INSTRUCTION = `If TESTS_FIELD below is present and is not the literal string "skip", it holds an
example test the user wrote: write that test first, then expand it to also cover the
individual functions/subparts you build, before writing the implementation. Otherwise
skip TDD entirely and just write the code.`;

const worktreePath = (t: PreparedTask, relativePath: string) => `${t.repoRoot.replace(/\/+$/, "")}/${relativePath}`;

const shellQuote = (value: unknown) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

const ownedPathMap = (t: PreparedTask) => t.files
    .map((file) => `  - ${file} => ${worktreePath(t, file)}`)
    .join("\n");

// ---------------------------------------------------------------------------
// Shared codex command + fallback chain, v1_1 lines 160-200. Both review roles call this to avoid drift.
// ---------------------------------------------------------------------------

export function codexReviewInstructions(question: string, subjectLabel: string): string {
    const prompt = JSON.stringify(question);
    const command = `codex exec -s read-only ${prompt}`;
    const fableFallbackCommand = `claude -p ${prompt} --tools "Read" --model fable --effort medium`;
    const opusFallbackCommand = `claude -p ${prompt} --tools "Read" --model claude-opus-4-8 --effort high`;
    return `Review ${subjectLabel} for the task named by TASK_NUMBER in the DATA section by running exactly this command:

${command}

If that command exits with an error code, codex is unavailable — not a
verdict. Unavailability looks like a non-zero exit with no usable verdict at
all: overloaded api, usage exceeded, not logged in, rate limited, or no codex
binary on PATH. In that case run this command instead, and treat its output
exactly as you would codex's:

${fableFallbackCommand}
if that command also exits with an error code, run this command instead, and treat its output exactly as you would codex's:

${opusFallbackCommand}

Whichever reviewer answers, never run any command other than the ones above.

Report which reviewer actually produced the verdict you return: reviewer
"codex" if the codex command answered, reviewer "claude" if you had to fall
back. Never report a fallback review as codex.`;
}

// ---------------------------------------------------------------------------
// review-plan — copied from codexPrompt + verifierBrief; returns codex-review.json instead of APPROVED/REJECTED prose.
// ---------------------------------------------------------------------------

function reviewPlanQuestion(t: PreparedTask): string {
    return `Review an implementation plan. Read only BRIEF_FILE and PLAN_FILE, listed in DATA
below. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the
task's owned files, listed in OWNED_FILES below, it gives concrete steps rather than open
design questions, and someone could follow it without having to decide anything the plan
should have already decided.

Return your verdict as JSON matching plans/plan-format.md's codex-review.json:
{"verdict": "amend"|"scrap", "notes": "...", "amendments": [...]}
Use "scrap" (with notes, no amendments) when the plan cannot be fixed by amending
sections in place. Use "amend" (with at least one amendment) otherwise. Every
amendment names an existing section id — {"op": "replace", "id": "...", "body": "..."}
rewrites a section, {"op": "insert", "after": "...", "id": "...", "title": "...", "body": "..."}
adds one after an existing id, {"op": "remove", "id": "..."} drops one. Never invent an
id an "amend" verdict cannot point back to a real section it is amending.

---- DATA ----
BRIEF_FILE = ${t.briefFile}
PLAN_FILE = ${t.planFile}
OWNED_FILES = ${t.files.join(", ")}`;
}

export function reviewPlanPrompt(t: PreparedTask): string {
    return `Never edit any file — this agent only reviews the plan, it never applies fixes to it.

Write the reviewer's JSON verdict to exactly this absolute path: REVIEW_FILE (see final DATA section).

Return {reviewWritten: true, reviewer}.

${codexReviewInstructions(reviewPlanQuestion(t), "the plan")}

---- DATA ----
TASK_NUMBER = ${t.number}
REVIEW_FILE = ${t.reviewFile}`;
}

// ---------------------------------------------------------------------------
// review-tests — copied from verifierBrief's command scaffolding, with a new review question. Never run the tests.
// ---------------------------------------------------------------------------

function reviewTestsQuestion(t: PreparedTask): string {
    return `Review the tests for this task against what the task asked for. Read only BRIEF_FILE,
PLAN_FILE, and the task's own test files, listed in DATA below. Do not edit anything, and
never run the tests — you are judging what they assert, not whether they pass.

Flag a test only when it is wrong about what the task asked for: it asserts something the
brief or plan does not call for, or it asserts nothing. Do not flag a test merely because
you would have written it differently.

Return your verdict as JSON: {"flagged": true|false, "notes": "..."}

---- DATA ----
TASK_NUMBER = ${t.number}
BRIEF_FILE = ${t.briefFile}
PLAN_FILE = ${t.planFile}`;
}

export function reviewTestsPrompt(t: PreparedTask): string {
    return `Never edit any file, and never run the tests — this agent only reviews what they assert.

Write the reviewer's JSON verdict to exactly this absolute path: TEST_REVIEW_FILE (see final DATA section).

Return {flagged, reviewer}.

${codexReviewInstructions(reviewTestsQuestion(t), "the tests")}

---- DATA ----
TASK_NUMBER = ${t.number}
TEST_REVIEW_FILE = ${t.testReviewFile}`;
}

// ---------------------------------------------------------------------------
// implement — copied from workerBrief, with its commit steps dropped. The commit box owns committing (rule 1).
// ---------------------------------------------------------------------------

export function implementPrompt(t: PreparedTask, note: string, typecheckCommand: string, maxFixRounds: number): string {
    const rootedTypecheck = `(cd -- ${shellQuote(t.repoRoot)} && ${typecheckCommand})`;
    const testCommandWrapper = `(cd -- ${shellQuote(t.repoRoot)} && <test command>)`;
    return `You are implementing EXACTLY ONE pre-planned task, task #TASK_NUMBER (see DATA below).

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

taskWorktree = TASK_WORKTREE (see DATA below)
ownedFiles = OWNED_FILES (see DATA below)
ownedPaths (the only editable source/test paths) = OWNED_PATHS (see DATA below)
plan = PLAN_FILE (see DATA below)
notesFile = NOTES_FILE (see DATA below)
timeBudget = 10 minutes
note = NOTE (see DATA below; "(none)" means no note)
typecheckCommand = TYPECHECK_COMMAND (see DATA below)
testCommandWrapper = TEST_COMMAND_WRAPPER (see DATA below)
maxFixRounds = MAX_FIX_ROUNDS (see DATA below)

${TDD_INSTRUCTION}

Treat taskWorktree as the project root for jot:implement. Every repo-relative
path in the plan means its absolute path under taskWorktree. Use absolute paths
for Read/Edit/Search. Never edit the corresponding path in the ambient checkout.

use jot:implement plan, writing its implementation-notes log to exactly notesFile

if the plan is impossible as written:
    return {implemented: false, implementationNotesFile: notesFile, remaining: []}

implement every step of the plan, editing only ownedPaths

typecheck = run(typecheckCommand)
if typecheck reported errors in ownedPaths:
    fix them using their absolute taskWorktree paths

if the file scripts/relatedTests.ts exists under taskWorktree:
    tests = run it from taskWorktree to discover the tests covering ownedFiles
else:
    tests = the absolute test paths under taskWorktree belonging to ownedFiles
// never run the full suite; that is the close-tasks gate, not yours

results = run every test command as testCommandWrapper
fixRound = 0
while any test failed and fixRound is less than maxFixRounds:
    fixRound = fixRound + 1
    fix the cause
    typecheck = run(typecheckCommand)
    results = run every test command as testCommandWrapper

if any test still failed after maxFixRounds fix rounds:
    return {implemented: false, implementationNotesFile: notesFile, remaining: the failing test names}

if typecheck is clean and every test passed:
    return {implemented: true, implementationNotesFile: notesFile, remaining: []}
else if part of the plan is implemented:
    return {implemented: false, implementationNotesFile: notesFile, remaining: the plan steps not yet done, plus any failing test names}
else:
    return {implemented: false, implementationNotesFile: notesFile, remaining: the failing test names}

if you reach timeBudget before finishing:
    return {implemented: false, implementationNotesFile: notesFile, remaining: the not-yet-done plan steps}

You are forbidden to touch anything outside ownedPaths excluding notesFile; to
add scope or refactors the plan does not call for; to redecide anything the
plan already decided; to run the full suite; to stage or commit anything
yourself — a later step owns committing; to attempt more than maxFixRounds fix
rounds; or to return implemented true with a failing test. Any test file created
or modified must be listed in ownedFiles; otherwise return implemented false
without editing it.

You are forbidden to use an ambient-cwd-relative filesystem path or run any git
command yourself. Every shell command other than a filesystem tool call must
explicitly run inside taskWorktree.

---- DATA ----
TASK_NUMBER = ${t.number}
TASK_WORKTREE = ${t.repoRoot}
OWNED_FILES = ${t.files.join(", ")}
OWNED_PATHS (repo-relative => absolute in TASK_WORKTREE) =
${ownedPathMap(t)}
PLAN_FILE = ${t.planFile}
NOTES_FILE = ${t.notesFile}
NOTE (context passed in for this run) =
${note || "(none)"}
TESTS_FIELD (task's tests field; empty or "skip" means no TDD requirement) =
${t.tests ?? "(none)"}
TYPECHECK_COMMAND (run from TASK_WORKTREE) = ${rootedTypecheck}
TEST_COMMAND_WRAPPER (wrap each test command as) = ${testCommandWrapper}
MAX_FIX_ROUNDS = ${maxFixRounds}`;
}

// ---------------------------------------------------------------------------
// fix-conflicts — from mergeConflictBrief, git add lines dropped. Keeps "no git rebase --continue"; "advance the rebase" does that now.
// ---------------------------------------------------------------------------

export function fixConflictsPrompt(checkoutPath: string, conflictedFilePaths: string[]): string {
    return `A rebase in CHECKOUT_PATH (see DATA below) is stopped on live conflict markers, not
aborted. Resolve exactly the conflicted paths listed in CONFLICTED_PATHS below — that is
the complete list, do not search the repository for more.

Carry out every step below, in order, from top to bottom.
A line reading \`return {...}\` means stop and report exactly those fields.

You may READ anything, anywhere in the tree — callers, callees, tests, other layers.
You may EDIT any file in any layer — resolving a conflict often means updating a call
site, and a call site can live in a different repository.

for each path in CONFLICTED_PATHS below:
    open CHECKOUT_PATH/path
    resolve every <<<<<<< / ======= / >>>>>>> block, keeping BOTH sides' intent
    remove the conflict markers
    leave it unstaged and uncommitted — "commit if needed" stages and commits every touched layer next

if resolving a conflict required editing a file in a DIFFERENT repository than CHECKOUT_PATH:
    edit it there too, and leave that edit uncommitted as well

Do not run \`git rebase --continue\` or \`git rebase --abort\` in CHECKOUT_PATH yourself — the caller drives that after you return.

if every listed path has no remaining conflict markers:
    return {resolved: true, unresolvedPaths: []}
else:
    return {resolved: false, unresolvedPaths: the paths still containing conflict markers}

You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset anything you did not create; to run
\`git rebase --continue\` or \`git rebase --abort\` yourself; to stage or commit
anything yourself; or to leave a required edit in a different repository unmade.
Returning resolved false is a correct outcome when a conflict genuinely cannot
be resolved, not a failure.

---- DATA ----
CHECKOUT_PATH = ${checkoutPath}
CONFLICTED_PATHS =
${conflictedFilePaths.length === 0 ? "  (none)" : conflictedFilePaths.map((p) => `  - ${p}`).join("\n")}`;
}

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
            return reviewPlanPrompt(loadPreparedTask(taskNumber, worktree, projectRoot));
        case "implement":
            return implementPrompt(
                loadPreparedTask(taskNumber, worktree, projectRoot),
                typeof payload.note === "string" ? payload.note : "",
                typeof payload.typecheckCommand === "string" ? payload.typecheckCommand : "npx tsc --noEmit",
                typeof payload.maxFixRounds === "number" ? payload.maxFixRounds : 3,
            );
        case "fix-conflicts":
            return fixConflictsPrompt(payload.checkoutPath as string, Array.isArray(payload.conflictedFilePaths) ? payload.conflictedFilePaths as string[] : []);
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
