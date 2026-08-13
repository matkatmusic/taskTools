// Emits the yellow-box prompt text for one tackle-tasks agent role. This is the only place
// that imports data scripts to build a prompt — see workflow-only-context-injection.md §2/§6.
// Prompt text is copied from scripts/tackle-tasks-v1_1_AgentPromptEmitter.ts per the mapping
// table at plans/tackle-tasks-v1_5-plan.md lines 1405-1414; only the edits that table names
// were made. No CLI role here ever tells the agent to run a git command — the commit box
// owns committing (rule 1).
import { readFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import { writeTaskBrief } from "./writeTaskBrief.ts";

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

export type PreparedTask = {
    number: number;
    briefFile: string;
    planFile: string;
    reviewFile: string;
    testReviewFile: string;
    notesFile: string;
    files: string[];
    tests: string | null;
    repoRoot: string;
    taskStateRoot: string;
};

// ---------------------------------------------------------------------------
// Shared prompt-building helpers, verbatim from tackle-tasks-v1_1_AgentPromptEmitter.ts.
// ---------------------------------------------------------------------------

const testsInstruction = (t: PreparedTask) => t.tests && t.tests !== "skip"
    ? `The task's tests field holds an example test the user wrote — put it into the plan's verification section as the concrete check to run, expanded with a few extra cases covering the individual functions/subparts it touches: ${t.tests}`
    : 'This task has no tests field, or it is the literal string "skip" — do not require TDD; write ordinary verification commands in the plan instead.';

const tddInstruction = (t: PreparedTask) => t.tests && t.tests !== "skip"
    ? `This task's tests field holds an example test the user wrote: ${t.tests}\nWrite that test first, then expand it to also cover the individual functions/subparts you build, before writing the implementation.`
    : 'This task has no tests field, or it is the literal string "skip" — skip TDD entirely and just write the code.';

const worktreePath = (t: PreparedTask, relativePath: string) => `${t.repoRoot.replace(/\/+$/, "")}/${relativePath}`;

const shellQuote = (value: unknown) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

const ownedPathMap = (t: PreparedTask) => t.files
    .map((file) => `  - ${file} => ${worktreePath(t, file)}`)
    .join("\n");

// ---------------------------------------------------------------------------
// loadPreparedTask — paths updated per plans/tackle-tasks-v1_5-plan.md Phase 9.
// ---------------------------------------------------------------------------

export function loadPreparedTask(taskNumber: number, worktree: string, projectRoot: string): PreparedTask {
    const pair = resolveTaskFiles(projectRoot);
    const task = readTaskFile(pair.tasksPath).find((entry: any) => entry.taskNumber === taskNumber);
    if (!task) fail(`task ${taskNumber} not found in tasks.json`);
    const briefFile = writeTaskBrief(taskNumber, worktree, projectRoot);
    return {
        number: taskNumber,
        briefFile,
        planFile: `${worktree}/plans/plan.json`,
        reviewFile: `${worktree}/plans/codex-review.json`,
        testReviewFile: `${worktree}/plans/test-review.json`,
        notesFile: `${worktree}/plans/task-${taskNumber}-implementation-notes.md`,
        files: Array.isArray((task as any).files) ? (task as any).files : [],
        tests: typeof (task as any).tests === "string" ? (task as any).tests : null,
        repoRoot: worktree,
        taskStateRoot: projectRoot,
    };
}

// ---------------------------------------------------------------------------
// Shared codex command + fallback chain — v1_1 lines 160-200, verbatim structure.
// Both review roles call this so the chain cannot drift between them.
// ---------------------------------------------------------------------------

export function codexReviewInstructions(question: string, subjectLabel: string, taskNumber: number): string {
    const prompt = JSON.stringify(question);
    const command = `codex exec -s read-only ${prompt}`;
    const fableFallbackCommand = `claude -p ${prompt} --tools "Read" --model fable --effort medium`;
    const opusFallbackCommand = `claude -p ${prompt} --tools "Read" --model claude-opus-4-8 --effort high`;
    return `Review ${subjectLabel} for task #${taskNumber} by running exactly this command:

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
// plan — copied from plannerBrief; writes plan.json per plans/plan-format.md and
// accepts an optional preamble carrying codex's scrap notes.
// ---------------------------------------------------------------------------

export function planPrompt(t: PreparedTask, preamble = ""): string {
    return `${preamble}Invoke /ponytail:ponytail ultra.
taskWorktree = ${t.repoRoot}
Read this brief file by its absolute path: ${t.briefFile}
Owned files (repo-relative => absolute in taskWorktree):
${ownedPathMap(t)}

For every filesystem tool call, use the absolute taskWorktree path shown above.
Never resolve a repo-relative task path against your ambient working directory,
and never read or edit the same relative path in another checkout.

Read the owned files — a plan that guesses at their contents will be rejected.
Follow ~/.claude/guides/planning.md and write the plan as JSON to exactly this
absolute path: ${t.planFile}
Do not change any source file — this is planning only, not implementation.

Write the plan per plans/plan-format.md:
{"task": ${t.number}, "revision": 1, "sections": [{"id": "...", "title": "...", "body": "markdown"}]}
Each section id is stable, lowercase, kebab-case, and unique within the plan — codex
addresses feedback by id, and a renamed id orphans that feedback. "sections" order is
the plan order; nothing else encodes sequence. Each body is markdown, following
~/.claude/guides/planning.md — how and in what order, not why. Test-first per
~/.claude/guides/tdd.md.
${preamble ? "\nThe text above this brief is codex's reason for scrapping the previous plan — address it in the sections you write.\n" : ""}
The plan must be exact enough that the implementer makes no discovery of its own:
- Name every edit by file path and line number, with the current text and what it becomes.
- Account for every owned file: either its exact edit list, or the reason it needs no edit.
- Resolve every question while planning. Write no conditional instruction — no
  "re-check", no "verify before editing", no "if the live file disagrees", no
  "trust the live file". If you could not settle something, that is
  needs-clarification, not a fallback sentence in the plan.
- Quote only text you actually read. Never describe an excerpt the brief does not contain.
- State the verification that proves the change worked, as commands with expected results.
- ${testsInstruction(t)}

If the plan would need to edit a file outside the absolute owned paths above, set status
"needs-clarification" and name that file in "question" — do not plan the edit anyway.
If the blocker is instead that you need to READ a file outside the absolute owned paths
to write an exact plan, set status "needs-clarification", populate
missingFiles with the repo-relative path(s) of each file you need, and use
"question" to explain why each path is needed.
If the task is unclear, set status "needs-clarification" and put your
question in "question". If the task no longer applies to the codebase, set
status "not-relevant" and explain why in "question". Otherwise write the
plan file and set status "planned".
Return {task: ${t.number}, status, planFile: "${t.planFile}", question, missingFiles}.
You are forbidden to edit any file other than ${t.planFile}; to read a task source
file outside the absolute owned paths; to leave a decision for the implementer; or to
write a plan step whose exact target you did not read. The absolute brief and plan paths
above, plus ~/.claude/guides/planning.md, are the only non-source read exceptions.`;
}

// ---------------------------------------------------------------------------
// review-plan — copied from codexPrompt + verifierBrief; returns codex-review.json
// instead of APPROVED/REJECTED prose.
// ---------------------------------------------------------------------------

function reviewPlanQuestion(t: PreparedTask): string {
    return `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${t.planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(", ")}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Return your verdict as JSON matching plans/plan-format.md's codex-review.json:
{"verdict": "amend"|"scrap", "notes": "...", "amendments": [...]}
Use "scrap" (with notes, no amendments) when the plan cannot be fixed by amending
sections in place. Use "amend" (with at least one amendment) otherwise. Every
amendment names an existing section id — {"op": "replace", "id": "...", "body": "..."}
rewrites a section, {"op": "insert", "after": "...", "id": "...", "title": "...", "body": "..."}
adds one after an existing id, {"op": "remove", "id": "..."} drops one. Never invent an
id an "amend" verdict cannot point back to a real section it is amending.`;
}

export function reviewPlanPrompt(t: PreparedTask): string {
    return `${codexReviewInstructions(reviewPlanQuestion(t), "the plan", t.number)}

Never edit any file — this agent only reviews the plan, it never applies fixes to it.

Write the reviewer's JSON verdict to exactly this absolute path: ${t.reviewFile}

Return {task: ${t.number}, reviewWritten: true, reviewer}.`;
}

// ---------------------------------------------------------------------------
// review-tests — copied from verifierBrief's command scaffolding, with a new
// review question. Never run the tests.
// ---------------------------------------------------------------------------

function reviewTestsQuestion(t: PreparedTask): string {
    return `Review the tests for task #${t.number} against what the task asked for. Read only the brief ${t.briefFile}, the plan ${t.planFile}, and the task's own test files. Do not edit anything, and never run the tests — you are judging what they assert, not whether they pass.

Flag a test only when it is wrong about what the task asked for: it asserts something the brief or plan does not call for, or it asserts nothing. Do not flag a test merely because you would have written it differently.

Return your verdict as JSON: {"flagged": true|false, "notes": "..."}`;
}

export function reviewTestsPrompt(t: PreparedTask): string {
    return `${codexReviewInstructions(reviewTestsQuestion(t), "the tests", t.number)}

Never edit any file, and never run the tests — this agent only reviews what they assert.

Write the reviewer's JSON verdict to exactly this absolute path: ${t.testReviewFile}

Return {task: ${t.number}, flagged, reviewer}.`;
}

// ---------------------------------------------------------------------------
// implement — copied from workerBrief, with its commit steps dropped. The commit
// box owns committing (rule 1).
// ---------------------------------------------------------------------------

export function implementPrompt(t: PreparedTask, note: string, typecheckCommand: string, maxFixRounds: number): string {
    const rootedTypecheck = `(cd -- ${shellQuote(t.repoRoot)} && ${typecheckCommand})`;
    return `You are implementing EXACTLY ONE pre-planned task from
${worktreePath(t, ".taskTools/tasks.json")}: #${t.number}.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

taskWorktree = ${t.repoRoot}
ownedFiles = ${t.files.join(", ")}
ownedPaths (the only editable source/test paths) =
${ownedPathMap(t)}
plan = ${t.planFile}
notesFile = ${t.notesFile}
timeBudget = 10 minutes
${note ? `note = ${note}\n` : ""}
${tddInstruction(t)}

Treat taskWorktree as the project root for jot:implement. Every repo-relative
path in the plan means its absolute path under taskWorktree. Use absolute paths
for Read/Edit/Search. Never edit the corresponding path in the ambient checkout.

use jot:implement ${t.planFile}, writing its implementation-notes log to exactly notesFile

if the plan is impossible as written:
    return {task: ${t.number}, implemented: false, implementationNotesFile: notesFile, remaining: [], summary: why it cannot be done}

implement every step of the plan, editing only ownedPaths

typecheck = run(${rootedTypecheck})
if typecheck reported errors in ownedPaths:
    fix them using their absolute taskWorktree paths

if ${worktreePath(t, "scripts/relatedTests.ts")} exists:
    tests = run it from taskWorktree to discover the tests covering ownedFiles
else:
    tests = the absolute test paths under taskWorktree belonging to ownedFiles
// never run the full suite; that is the close-tasks gate, not yours

results = run every test command as (cd -- ${shellQuote(t.repoRoot)} && <test command>)
fixRound = 0
while any test failed and fixRound is less than ${maxFixRounds}:
    fixRound = fixRound + 1
    fix the cause
    typecheck = run(${rootedTypecheck})
    results = run every test command as (cd -- ${shellQuote(t.repoRoot)} && <test command>)

if any test still failed after ${maxFixRounds} fix rounds:
    return {task: ${t.number}, implemented: false, implementationNotesFile: notesFile, remaining: the failing test names}

if typecheck is clean and every test passed:
    return {task: ${t.number}, implemented: true, implementationNotesFile: notesFile, remaining: []}
else if part of the plan is implemented:
    return {task: ${t.number}, implemented: false, implementationNotesFile: notesFile, remaining: the plan steps not yet done, plus any failing test names}
else:
    return {task: ${t.number}, implemented: false, implementationNotesFile: notesFile, remaining: the failing test names}

if you reach timeBudget before finishing:
    return {task: ${t.number}, implemented: false, implementationNotesFile: notesFile, remaining: the not-yet-done plan steps}

You are forbidden to touch anything outside ownedPaths excluding notesFile; to
add scope or refactors the plan does not call for; to redecide anything the
plan already decided; to run the full suite; to stage or commit anything
yourself — a later step owns committing; to attempt more than ${maxFixRounds} fix
rounds; or to return implemented true with a failing test. Any test file created
or modified must be listed in ownedFiles; otherwise return implemented false
without editing it.

You are forbidden to use an ambient-cwd-relative filesystem path or run any git
command yourself. Every shell command other than a filesystem tool call must
explicitly run inside taskWorktree.`;
}

// ---------------------------------------------------------------------------
// fix-conflicts — copied from mergeConflictBrief, with its git add lines dropped.
// Returns {resolved, unresolvedPaths}. Keeps "do not run git rebase --continue" —
// correct now because "advance the rebase" does that.
// ---------------------------------------------------------------------------

export function fixConflictsPrompt(checkoutPath: string, conflictedFilePaths: string[]): string {
    return `A rebase in ${checkoutPath} is stopped on live conflict markers, not aborted. Resolve exactly these conflicted paths — this is the complete list, do not search the repository for more:
${conflictedFilePaths.map((p) => `  - ${p}`).join("\n")}

Carry out every step below, in order, from top to bottom.
A line reading \`return {...}\` means stop and report exactly those fields.

You may READ anything, anywhere in the tree — callers, callees, tests, other layers.
You may EDIT any file in any layer — resolving a conflict often means updating a call
site, and a call site can live in a different repository.

for each path in the list above:
    open ${checkoutPath}/path
    resolve every <<<<<<< / ======= / >>>>>>> block, keeping BOTH sides' intent
    remove the conflict markers
    leave it unstaged and uncommitted — "commit if needed" stages and commits every touched layer next

if resolving a conflict required editing a file in a DIFFERENT repository than ${checkoutPath}:
    edit it there too, and leave that edit uncommitted as well

Do not run \`git rebase --continue\` or \`git rebase --abort\` in ${checkoutPath} yourself — the caller drives that after you return.

if every listed path has no remaining conflict markers:
    return {resolved: true, unresolvedPaths: []}
else:
    return {resolved: false, unresolvedPaths: the paths still containing conflict markers}

You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset anything you did not create; to run
\`git rebase --continue\` or \`git rebase --abort\` yourself; to stage or commit
anything yourself; or to leave a required edit in a different repository unmade.
Returning resolved false is a correct outcome when a conflict genuinely cannot
be resolved, not a failure.`;
}

// ---------------------------------------------------------------------------
// fix-suite / fix-tests — copied from rebaseFixBrief, with the permission to edit
// the failing test removed and the self-commit removed. "fix the codebase" edits
// source, never tests (diagram rule 4).
// ---------------------------------------------------------------------------

function fixCodebasePrompt(subject: string, checkoutPath: string, testOutput: string, forbiddenPaths: string[]): string {
    return `${subject} is RED, in ${checkoutPath}. Fix the cause.

Carry out every step below, in order, from top to bottom.
A line reading \`return {...}\` means stop and report exactly those fields.

Failure output from the test run:
${testOutput}

You may READ anything, anywhere in the tree. You may EDIT the source code inside
${checkoutPath} that the failing test covers — never the test itself. Do not edit any
file outside ${checkoutPath}. These paths inside ${checkoutPath} are OTHER layers
(separate occurrences) and are out of scope even though they sit on disk under
${checkoutPath} — do not edit anything inside them: ${forbiddenPaths.length === 0 ? "(none)" : forbiddenPaths.join(", ")}

fix the cause of the failure

leave your fix uncommitted — "commit if needed" stages and commits every touched
layer next; do not stage or commit anything yourself

if the fix addresses every failure listed above:
    return {fixed: true}
else:
    return {fixed: false}

You are forbidden to weaken, delete, or stub out a test or the code it covers
to make the failure disappear; to edit a test file at all; to edit any file
outside ${checkoutPath}, or inside a layer listed above as out of scope; to
force-push or hard-reset anything you did not create; or to stage or commit
anything yourself.`;
}

export function fixSuitePrompt(checkoutPath: string, occurrenceId: string, testOutput: string, forbiddenPaths: string[]): string {
    const layer = occurrenceId === "" ? "root" : occurrenceId;
    return fixCodebasePrompt(`The full suite for layer "${layer}"`, checkoutPath, testOutput, forbiddenPaths);
}

export function fixTestsPrompt(checkoutPath: string, occurrenceId: string, testOutput: string, forbiddenPaths: string[], taskNumber: number): string {
    const layer = occurrenceId === "" ? "root" : occurrenceId;
    return fixCodebasePrompt(`The tests for task #${taskNumber} in layer "${layer}"`, checkoutPath, testOutput, forbiddenPaths);
}

// ---------------------------------------------------------------------------
// amend-tests — copied from applyFeedbackBrief, retargeted at test files. The
// only role that may edit tests: freely for files it created, only when broken
// or assertion-free for a pre-existing test it merely modified (diagram rule 3).
// ---------------------------------------------------------------------------

export function amendTestsPrompt(t: PreparedTask, notes: string, createdTestFiles: string[], testFiles: string[]): string {
    return `Apply test-review feedback. The reviewer's notes are below, verbatim:

${notes}

Files you created in this task's own worktree, and may freely edit:
${createdTestFiles.length === 0 ? "  (none)" : createdTestFiles.map((f) => `  - ${f}`).join("\n")}

Pre-existing test files this task modified, but did not create — the diagram's rule
that a test not created in this task's worktree may only be changed when it is broken
or asserts nothing applies to every one of these, and to no other file:
${testFiles.length === 0 ? "  (none)" : testFiles.map((f) => `  - ${f}`).join("\n")}

Read ${t.testReviewFile}, then edit only the files listed above, changing exactly what
the feedback calls for. Never edit a source file, the brief, or the plan, and never edit
a pre-existing test file for any reason other than it being broken or asserting nothing.

Leave your edits uncommitted — "commit if needed" stages and commits every touched
layer next; do not stage or commit anything yourself.

If there is nothing to apply, make no edits and return amended false.

Return {task: ${t.number}, amended: true} once you have made the edits, or {task: ${t.number}, amended: false} if there was nothing to apply.

You are forbidden to edit any file other than the ones listed above; to change a
pre-existing test file except to fix it when it is broken or asserts nothing; or to
stage or commit anything yourself.`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function emitAgentPrompt(taskNumber: number, role: string, payload: AgentPromptEmitterPayload): string {
    const worktree = payload.worktree;
    const projectRoot = payload.projectRoot;
    switch (role) {
        case "plan":
            return planPrompt(loadPreparedTask(taskNumber, worktree, projectRoot), typeof payload.preamble === "string" ? payload.preamble : "");
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
        case "fix-suite":
            return fixSuitePrompt(
                payload.checkoutPath as string,
                typeof payload.occurrenceId === "string" ? payload.occurrenceId : "",
                typeof payload.testOutput === "string" ? payload.testOutput : "",
                Array.isArray(payload.forbiddenPaths) ? payload.forbiddenPaths as string[] : [],
            );
        case "fix-tests":
            return fixTestsPrompt(
                payload.checkoutPath as string,
                typeof payload.occurrenceId === "string" ? payload.occurrenceId : "",
                typeof payload.testOutput === "string" ? payload.testOutput : "",
                Array.isArray(payload.forbiddenPaths) ? payload.forbiddenPaths as string[] : [],
                taskNumber,
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
        process.stdout.write(emitAgentPrompt(N, ROLE, PAYLOAD));
    } catch (error) {
        fail(String((error as Error)?.message ?? error));
    }
}
