import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

import { resolveTaskFiles, readTaskFile } from "./taskFiles.ts";
import { writeTaskBriefFile, attachOperationBranch, releaseTaskWorktreeLease, taskWorktreeLeasePath } from "./prepareTasks.ts";
import { addTaskFiles } from "./addTaskFiles.ts";
import {
  rebaseSubmoduleLayersDeepestFirst,
  rebaseParentOntoSourceAndTest,
  uncommittedChangedFiles,
  mergeTaskDeepestFirst,
  removeTaskWorktreeAndBranches,
  deleteTaskMergePersistence,
  collectRetainedTaskArtifacts,
} from "./mergeTaskWorktrees.ts";
import { createEmptyResolutionManifest } from "./resolutionRequests.ts";
import { currentBranchName } from "./repositoryBranches.ts";
import { closeTasks } from "./closeTasks.ts";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function fail(problem: string): never {
  process.stderr.write(`tackle-tasks_AgentPromptEmitter: ${problem}\n`);
  process.exit(1);
}

const N = Number(process.argv[2]);
const ROLE = process.argv[3];
if (!Number.isInteger(N)) fail(`invalid task number: ${process.argv[2]}`);
if (!ROLE) fail("no role given");

const payloadText = readStdin();
const PAYLOAD: any = payloadText ? JSON.parse(payloadText) : {};
const WORKTREE: string = PAYLOAD.worktree;
const SOURCE_ROOT: string = PAYLOAD.sourceRoot;
const RUN_ID: string = PAYLOAD.runId;
if (!WORKTREE) fail('payload missing "worktree"');

function printResult(json: unknown) {
  process.stdout.write(`Return exactly this JSON as your structured result, with no other keys added or removed:\n${JSON.stringify(json)}\n`);
}

// ---------------------------------------------------------------------------
// Task data
// ---------------------------------------------------------------------------

type PreparedTask = {
  number: number;
  briefFile: string;
  planFile: string;
  notesFile: string;
  files: string[];
  tests: string | null;
  repoRoot: string;
  taskStateRoot: string;
};

// Task state (ownership, widening) is authoritative under SOURCE_ROOT; only the brief/plan/notes/edits live under WORKTREE.
function loadPreparedTask(): PreparedTask {
  const pair = resolveTaskFiles(SOURCE_ROOT);
  const task = readTaskFile(pair.tasksPath).find((entry: any) => entry.taskNumber === N);
  if (!task) fail(`task ${N} not found in tasks.json`);
  const briefFile = writeTaskBriefFile(task, WORKTREE);
  return {
    number: N,
    briefFile,
    planFile: `${WORKTREE}/plans/task-${N}-plan.md`,
    notesFile: `${WORKTREE}/plans/task-${N}-implementation-notes.md`,
    files: Array.isArray(task.files) ? task.files : [],
    tests: typeof task.tests === 'string' ? task.tests : null,
    repoRoot: WORKTREE,
    taskStateRoot: SOURCE_ROOT,
  };
}

// ---------------------------------------------------------------------------
// Prompt-building helpers, verbatim from the pre-C86-18 task.workflow.js (see plans/task-86-agent-prompt-fixtures/*.txt for the golden output).
// ---------------------------------------------------------------------------

const testsInstruction = (t: PreparedTask) => t.tests && t.tests !== 'skip'
  ? `The task's tests field holds an example test the user wrote — put it into the plan's verification section as the concrete check to run, expanded with a few extra cases covering the individual functions/subparts it touches: ${t.tests}`
  : 'This task has no tests field, or it is the literal string "skip" — do not require TDD; write ordinary verification commands in the plan instead.'

const worktreePath = (t: PreparedTask, relativePath: string) => `${t.repoRoot.replace(/\/+$/, '')}/${relativePath}`

const shellQuote = (value: unknown) => `'${String(value).replaceAll("'", "'\"'\"'")}'`

const ownedPathMap = (t: PreparedTask) => t.files
  .map((file) => `  - ${file} => ${worktreePath(t, file)}`)
  .join('\n')

const plannerBrief = (t: PreparedTask, preamble = '') => `${preamble}Invoke /ponytail:ponytail ultra.
taskWorktree = ${t.repoRoot}
Read this brief file by its absolute path: ${t.briefFile}
Owned files (repo-relative => absolute in taskWorktree):
${ownedPathMap(t)}

For every filesystem tool call, use the absolute taskWorktree path shown above.
Never resolve a repo-relative task path against your ambient working directory,
and never read or edit the same relative path in another checkout.

Read the owned files — a plan that guesses at their contents will be rejected.
Follow ~/.claude/guides/planning.md and write the plan to exactly this absolute path: ${t.planFile}
Do not change any source file — this is planning only, not implementation.

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
above, plus ~/.claude/guides/planning.md, are the only non-source read exceptions.`

const codexPrompt = (t: PreparedTask, planFile: string) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, replace the FIXES section with a "MISSING_FILES:" section instead: one repo-relative file path per line, the paths the plan would need read access to, and no other text in that section.`

const verifierBrief = (t: PreparedTask, planFile: string) => {
  const prompt = JSON.stringify(codexPrompt(t, planFile))
  const command = `codex exec -s read-only ${prompt}`
  const opusFallbackCommand = `claude -p ${prompt} --tools "Read" --model claude-opus-4-8 --effort high`
  const fableFallbackCommand = `claude -p ${prompt} --tools "Read" --model fable --effort medium`
  return `Review the plan for task #${t.number} by running exactly this command:

${command}

If that command exits with an error code, codex is unavailable — not a
verdict. Unavailability looks like a non-zero exit with no APPROVED or
REJECTED first line and no PROBLEMS or FIXES block: overloaded api, usage
exceeded, not logged in, rate limited, or no codex binary on PATH. In that
case run this command instead, and treat its output exactly as you would
codex's:

${fableFallbackCommand}
if that command also exits with an error code, run this command instead, and treat its output exactly as you would codex's:

${opusFallbackCommand}

Whichever reviewer answers prints its verdict on the first line. Never edit
any file — this agent only reviews the plan, it never applies fixes to it.
Never run any command other than the ones above.

Report which reviewer actually produced the verdict you return: reviewer
"codex" if the codex command answered, reviewer "claude" if you had to fall
back. Never report a fallback review as codex.

If the run prints APPROVED: return verdict "approved", missingFiles [], and
the reviewer's reasoning in notes.

If the run prints REJECTED: it also prints a PROBLEMS section, and either a
FIXES section or a MISSING_FILES section. Copy the PROBLEMS section and
whichever of FIXES or MISSING_FILES it printed into notes verbatim — that
text is the only thing anyone sees before deciding what to do about this
plan. If it printed a MISSING_FILES section, also copy each line of that
section into missingFiles as an array of repo-relative path strings.
Otherwise return missingFiles as an empty array.

Return {task: ${t.number}, verdict, notes, reviewer, missingFiles}.`
}

const applyFeedbackBrief = (t: PreparedTask, planFile: string, notes: string) => `Apply reviewer feedback to a plan file. The reviewer's PROBLEMS and FIXES are below, verbatim:

${notes}

Read ${planFile}, then edit it so it satisfies every fix listed above. The only file you may ever edit is ${planFile} — never touch a source file, the brief, or any other file, and never run any command.

If the text above has no FIXES section to apply (for example a MISSING_FILES section instead), make no edits and return applied false.

Return {task: ${t.number}, applied: true} once you have made the edits, or {task: ${t.number}, applied: false} if there was nothing to apply.`

const tddInstruction = (t: PreparedTask) => t.tests && t.tests !== 'skip'
  ? `This task's tests field holds an example test the user wrote: ${t.tests}\nWrite that test first, then expand it to also cover the individual functions/subparts you build, before writing the implementation.`
  : 'This task has no tests field, or it is the literal string "skip" — skip TDD entirely and just write the code.'

const workerBrief = (t: PreparedTask, note: string, typecheckCommand: string, maxFixRounds: number) => {
  const rootedTypecheck = `(cd -- ${shellQuote(t.repoRoot)} && ${typecheckCommand})`
  const gitAddPaths = t.files.length
    ? [...t.files, t.notesFile].map(shellQuote).join(' ')
    : `${shellQuote(t.notesFile)} (plus every other path you edited, listed explicitly)`

  return `You are implementing EXACTLY ONE pre-planned task from
${worktreePath(t, '.taskTools/tasks.json')}: #${t.number}.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

taskWorktree = ${t.repoRoot}
ownedFiles = ${t.files.join(', ')}
ownedPaths (the only editable source/test paths) =
${ownedPathMap(t)}
plan = ${t.planFile}
notesFile = ${t.notesFile}
timeBudget = 10 minutes
${note ? `note = ${note}\n` : ''}
${tddInstruction(t)}

Treat taskWorktree as the project root for jot:implement. Every repo-relative
path in the plan means its absolute path under taskWorktree. Use absolute paths
for Read/Edit/Search. Never edit the corresponding path in the ambient checkout.

use jot:implement ${t.planFile}, writing its implementation-notes log to exactly notesFile

if the plan is impossible as written:
    return {task: ${t.number}, status: "blocked", summary: why it cannot be done, remaining: [], notesFile: notesFile}

implement every step of the plan, editing only ownedPaths

typecheck = run(${rootedTypecheck})
if typecheck reported errors in ownedPaths:
    fix them using their absolute taskWorktree paths

if ${worktreePath(t, 'scripts/relatedTests.ts')} exists:
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
    return {task: ${t.number}, status: "blocked", summary: what is still failing after ${maxFixRounds} fix rounds, remaining: the failing test names, notesFile: notesFile}

if typecheck is clean and every test passed:
    run: git -C ${shellQuote(t.repoRoot)} add -- ${gitAddPaths}
    run: git -C ${shellQuote(t.repoRoot)} commit -m ${shellQuote(`task ${t.number}: one-line summary`)}
    return {task: ${t.number}, status: "done", summary: one sentence, remaining: [], notesFile: notesFile}
else if part of the plan is implemented:
    return {task: ${t.number}, status: "partial", summary: one sentence, remaining: the plan steps not yet done, plus any failing test names, notesFile: notesFile}
else:
    return {task: ${t.number}, status: "blocked", summary: one sentence, remaining: the failing test names, notesFile: notesFile}

if you reach timeBudget before finishing:
    return status "partial" with the not-yet-done plan steps in remaining, notesFile still set to notesFile

You are forbidden to touch anything outside ownedPaths excluding notesFile; to
add scope or refactors the plan does not call for; to redecide anything the
plan already decided; to run the full suite, \`git add -A\`, or \`git add .\`; to
commit while anything fails; to attempt more than ${maxFixRounds} fix
rounds; or to return status "done" with a failing test. Any test file created
or modified must be listed in ownedFiles; otherwise return status "blocked"
without editing it.

You are forbidden to use an ambient-cwd-relative filesystem path or a bare Git
command. Every Git command must use git -C taskWorktree, and every other shell
command must explicitly run inside taskWorktree.`
}

const mergeConflictBrief = (checkoutPath: string, conflictedFilePaths: string[]) => `A rebase in ${checkoutPath} is stopped on live conflict markers, not aborted. Resolve exactly these conflicted paths — this is the complete list, do not search the repository for more:
${conflictedFilePaths.map((p) => `  - ${p}`).join('\n')}

Carry out every step below, in order, from top to bottom.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

You may READ anything, anywhere in the tree — callers, callees, tests, other layers.
You may EDIT any file in any layer — resolving a conflict often means updating a call
site, and a call site can live in a different repository.

for each path in the list above:
    open ${checkoutPath}/path
    resolve every <<<<<<< / ======= / >>>>>>> block, keeping BOTH sides' intent
    remove the conflict markers
    run(git -C ${checkoutPath} add path)

if resolving a conflict required editing a file in a DIFFERENT repository than ${checkoutPath}:
    run(git add) and run(git commit) for that edit, in that repository's own checkout, before moving on
    // a rebase requires a clean tree; an uncommitted edit in a not-yet-rebased layer would break that layer's own rebase

Do not run \`git rebase --continue\` or \`git rebase --abort\` in ${checkoutPath} yourself — the caller drives that after you return.

if git -C ${checkoutPath} diff --name-only --diff-filter=U prints nothing (every listed path is resolved and staged):
    return {resolved: true, summary: what you changed}
else:
    return {resolved: false, summary: what is still unresolved and why}

You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset anything you did not create; to run
\`git rebase --continue\` or \`git rebase --abort\` yourself; or to leave an edit
in a different repository uncommitted. Returning resolved false is a correct
outcome when a conflict genuinely cannot be resolved, not a failure.`

const rebaseFixBrief = (checkoutPath: string, occurrenceId: string, testOutput: string, forbiddenPaths: string[]) => `The test suite for layer "${occurrenceId === '' ? 'root' : occurrenceId}" is RED after a rebase, in ${checkoutPath}. Fix the cause.

Carry out every step below, in order, from top to bottom.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

Failure output from the test run:
${testOutput}

You may READ anything, anywhere in the tree. You may EDIT any file inside ${checkoutPath} — the failing test, or the code it covers. Do not edit any file outside ${checkoutPath}. These paths inside ${checkoutPath} are OTHER layers (separate occurrences) and are out of scope even though they sit on disk under ${checkoutPath} — do not edit anything inside them: ${forbiddenPaths.length === 0 ? '(none)' : forbiddenPaths.join(', ')}

fix the cause of the failure

run(git -C ${checkoutPath} add -A)
run(git -C ${checkoutPath} commit -m "task ${N}: fix rebase-test failure in ${occurrenceId === '' ? 'root' : occurrenceId}")
// rebase needs a clean tree; this commit is never undone — it survives for the next lap

if git -C ${checkoutPath} status --porcelain prints nothing (the fix is committed):
    return {fixed: true, summary: what you changed}
else:
    return {fixed: false, summary: why the tree is still dirty}

You are forbidden to weaken, delete, or stub out a test or the code it covers
to make the failure disappear; to edit any file outside ${checkoutPath}, or
inside a layer listed above as out of scope; to force-push or hard-reset
anything you did not create; or to leave your edit uncommitted.`

// ---------------------------------------------------------------------------
// Git driver helpers
// ---------------------------------------------------------------------------

const readHeadOid = (checkoutPath: string) => execFileSync('git', ['-C', checkoutPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

const readOptionalRef = (checkoutPath: string, ref: string): string | null => {
  try {
    return execFileSync('git', ['-C', checkoutPath, 'rev-parse', '--verify', ref], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

// changedPaths from a name-only diff also lists deletions; this checks the blob still exists at HEAD.
const pathTrackedAtHead = (checkoutPath: string, relativePath: string): boolean => {
  try {
    execFileSync('git', ['-C', checkoutPath, 'cat-file', '-e', `HEAD:${relativePath}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const changedPathsSinceOid = (checkoutPath: string, beforeOid: string) => execFileSync('git', ['-C', checkoutPath, 'diff', '--name-only', `${beforeOid}..HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean)

// A sibling of WORKTREE, like taskWorktreeLeasePath: outside every checkout, never seen by its git status.
function advanceConflictReceiptsDir(worktreePath: string): string {
  return `${worktreePath}.advance-conflict-receipts`
}

type AdvanceConflictResult = {
  advanced: boolean;
  lastFailure: string | null;
  cleanupFailure: string | null;
  touchedPaths: { occurrenceId: string; path: string }[];
};

// Keyed by the conflicted commit's identity so a stale retry can't collide with the next conflict.
function advanceConflictReceiptPath(occurrenceId: string, conflictIdentity: string): string {
  const key = createHash('sha256').update(JSON.stringify({ runId: RUN_ID, task: N, occurrenceId, conflictIdentity })).digest('hex')
  return join(advanceConflictReceiptsDir(WORKTREE), `${key}.json`)
}

function readAdvanceConflictReceipt(receiptPath: string): AdvanceConflictResult | null {
  if (!existsSync(receiptPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(receiptPath, 'utf8'))
    return parsed.result ?? null
  } catch {
    return null
  }
}

// Written before printResult so a lost-result retry can recover the exact prior outcome without redoing the mutation.
function writeAdvanceConflictReceipt(receiptPath: string, result: AdvanceConflictResult) {
  mkdirSync(dirname(receiptPath), { recursive: true })
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, JSON.stringify({ result }))
  renameSync(temporaryPath, receiptPath)
}

const commitOccurrenceChanges = (checkoutPath: string, occurrenceId: string) => {
  try {
    execFileSync('git', ['-C', checkoutPath, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', checkoutPath, 'commit', '-q', '-m', `resolve merge conflict: cross-layer edit in ${occurrenceId === '' ? 'root' : occurrenceId}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const abortRebaseChecked = (checkoutPath: string) => {
  try {
    execFileSync('git', ['-C', checkoutPath, 'rebase', '--abort'], { stdio: 'ignore' })
    return { aborted: true, failureReason: null as string | null }
  } catch (error) {
    return { aborted: false, failureReason: String((error as any)?.message ?? error) }
  }
}

// Editor disabled: a plain --continue must never block on an interactive prompt.
const continueRebaseChecked = (checkoutPath: string) => {
  try {
    execFileSync('git', ['-C', checkoutPath, 'rebase', '--continue'], { stdio: 'ignore', env: { ...process.env, GIT_EDITOR: 'true' } })
    return { continued: true, freshConflict: false, failureReason: null as string | null }
  } catch (error) {
    const stillConflicted = execFileSync('git', ['-C', checkoutPath, 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    if (stillConflicted.length > 0) return { continued: false, freshConflict: true, failureReason: null as string | null }
    return { continued: false, freshConflict: false, failureReason: String((error as any)?.message ?? error) }
  }
}

const buildManifest = () => {
  const repositoryManifest = PAYLOAD.repositoryManifest
  return {
    repositoryManifest: { ...repositoryManifest, occurrences: attachOperationBranch(repositoryManifest.occurrences, `task-${N}`) },
    resolutionManifest: createEmptyResolutionManifest(),
  }
}

// ---------------------------------------------------------------------------
// Role handlers
// ---------------------------------------------------------------------------

function roleTaskInfo() {
  const t = loadPreparedTask()
  printResult({ planFile: t.planFile, notesFile: t.notesFile, briefFile: t.briefFile, files: t.files, tests: t.tests })
}

function rolePlan() {
  const t = loadPreparedTask()
  process.stdout.write(plannerBrief(t, PAYLOAD.preamble ?? ''))
}

function roleWidenFiles() {
  const missingFiles: string[] = PAYLOAD.missingFiles ?? []
  const widened = addTaskFiles([N], missingFiles, SOURCE_ROOT)
  const widenedTask = widened.find((entry: any) => entry.taskNumber === N)
  if (!widenedTask) fail(`task ${N} disappeared from tasks.json`)
  writeTaskBriefFile(widenedTask, WORKTREE)
  printResult({ files: Array.isArray(widenedTask.files) ? widenedTask.files : [] })
}

// Accepts no PAYLOAD path; the expected plan file is always the same one loadPreparedTask computes.
function rolePlanFileStatus() {
  const expectedPlanFile = `${WORKTREE}/plans/task-${N}-plan.md`
  printResult({ exists: existsSync(expectedPlanFile) })
}

function roleVerify() {
  const t = loadPreparedTask()
  process.stdout.write(verifierBrief(t, t.planFile))
}

function roleApplyFeedback() {
  const t = loadPreparedTask()
  process.stdout.write(applyFeedbackBrief(t, t.planFile, PAYLOAD.notes ?? ''))
}

function roleGitHead() {
  printResult({ oid: readHeadOid(WORKTREE) })
}

function roleImplement() {
  const t = loadPreparedTask()
  process.stdout.write(workerBrief(t, PAYLOAD.note ?? '', PAYLOAD.typecheckCommand ?? 'npx tsc --noEmit', PAYLOAD.maxFixRounds ?? 3))
}

function roleImplementFinalize() {
  const baseOid: string = PAYLOAD.baseOid
  const notesRelative: string = PAYLOAD.notesRelative
  const headOid = readHeadOid(WORKTREE)
  const changedPaths = execFileSync('git', ['-C', WORKTREE, 'diff', '--name-only', '-z', `${baseOid}..HEAD`], { encoding: 'utf8' }).split('\0').filter(Boolean)
  const notesPresent = pathTrackedAtHead(WORKTREE, notesRelative)
  printResult({ headOid, changedPaths, notesPresent })
}

function roleOccurrenceOids() {
  const checkoutPaths: Record<string, string> = PAYLOAD.checkoutPaths ?? {}
  const oids: Record<string, string> = {}
  for (const [occurrenceId, checkoutPath] of Object.entries(checkoutPaths)) {
    oids[occurrenceId] = readHeadOid(checkoutPath)
  }
  printResult({ oids })
}

function roleRebaseWalk() {
  const manifest = buildManifest()
  const typecheckCommand = PAYLOAD.typecheckCommand ?? null
  const report = rebaseSubmoduleLayersDeepestFirst(WORKTREE, manifest, true, typecheckCommand)
  printResult(report)
}

function roleParentRebase() {
  const manifest = buildManifest()
  const occurrences = manifest.repositoryManifest.occurrences
  const rootOccurrence = occurrences.find((o: any) => o.occurrenceId === '')
  const submodulePaths = occurrences.filter((o: any) => o.parentOccurrenceId === '').map((o: any) => o.pathInParent).filter((p: any) => p !== null)
  const typecheckCommand = PAYLOAD.typecheckCommand ?? null
  const outcome: any = rebaseParentOntoSourceAndTest('', WORKTREE, rootOccurrence.baseBranch, submodulePaths, manifest.resolutionManifest, true, typecheckCommand)
  printResult({ stoppedAt: outcome.status === 'rebased-and-tested' ? null : outcome })
}

function roleMergeConflict() {
  process.stdout.write(mergeConflictBrief(PAYLOAD.checkoutPath, PAYLOAD.conflictedFilePaths ?? []))
}

function roleConflictIdentity() {
  printResult({ rebaseHead: readOptionalRef(PAYLOAD.checkoutPath, 'REBASE_HEAD') })
}

// Mirrors advanceLiveConflict's post-agent bookkeeping from the pre-C86-18 task.workflow.js.
function roleAdvanceConflict() {
  const occurrenceId: string = PAYLOAD.occurrenceId
  const conflictIdentity: string = PAYLOAD.conflictIdentity
  const conflictedFilePaths: string[] = PAYLOAD.conflictedFilePaths ?? []
  const resolved: boolean = PAYLOAD.resolved === true
  const beforeOids: Record<string, string> = PAYLOAD.beforeOids ?? {}
  const checkoutPaths: Record<string, string> = PAYLOAD.checkoutPaths ?? {}
  const checkoutPath = checkoutPaths[occurrenceId]
  const conflictSummary = `unresolved merge conflict in ${occurrenceId || 'root'}; unresolved paths: ${conflictedFilePaths.join(', ')}`

  const receiptPath = advanceConflictReceiptPath(occurrenceId, conflictIdentity)
  const priorResult = readAdvanceConflictReceipt(receiptPath)
  if (priorResult) { printResult(priorResult); return }

  const finish = (result: AdvanceConflictResult) => {
    writeAdvanceConflictReceipt(receiptPath, result)
    printResult(result)
  }

  if (!resolved) {
    const abortResult = abortRebaseChecked(checkoutPath)
    finish({ advanced: false, lastFailure: conflictSummary, cleanupFailure: abortResult.aborted ? null : `abort failed: ${abortResult.failureReason}`, touchedPaths: [] })
    return
  }

  const touchedPaths: { occurrenceId: string; path: string }[] = []
  for (const path of uncommittedChangedFiles(checkoutPath)) {
    if (!conflictedFilePaths.includes(path)) touchedPaths.push({ occurrenceId, path })
    execFileSync('git', ['-C', checkoutPath, 'add', path], { stdio: 'ignore' })
  }

  for (const [otherId, beforeOid] of Object.entries(beforeOids)) {
    const otherPath = checkoutPaths[otherId]
    const uncommitted = uncommittedChangedFiles(otherPath)
    for (const path of new Set([...changedPathsSinceOid(otherPath, beforeOid), ...uncommitted])) {
      touchedPaths.push({ occurrenceId: otherId, path })
    }
    if (uncommitted.length === 0) continue
    const committed = commitOccurrenceChanges(otherPath, otherId)
    if (!committed || uncommittedChangedFiles(otherPath).length > 0) {
      const abortResult = abortRebaseChecked(checkoutPath)
      const reason = `commit failed for occurrence "${otherId}"`
      finish({ advanced: false, lastFailure: conflictSummary, cleanupFailure: abortResult.aborted ? reason : `${reason}; abort failed: ${abortResult.failureReason}`, touchedPaths })
      return
    }
  }

  const continuation = continueRebaseChecked(checkoutPath)
  if (continuation.continued || continuation.freshConflict) {
    finish({ advanced: true, lastFailure: null, cleanupFailure: null, touchedPaths })
    return
  }
  const abortResult = abortRebaseChecked(checkoutPath)
  const reason = `continue failed: ${continuation.failureReason}`
  finish({ advanced: false, lastFailure: conflictSummary, cleanupFailure: abortResult.aborted ? reason : `${reason}; abort failed: ${abortResult.failureReason}`, touchedPaths })
}

function roleRebaseFix() {
  process.stdout.write(rebaseFixBrief(PAYLOAD.checkoutPath, PAYLOAD.occurrenceId, PAYLOAD.testOutput, PAYLOAD.forbiddenPaths ?? []))
}

// Mirrors attemptRebaseFix's post-agent bookkeeping from the pre-C86-18 task.workflow.js.
function roleRebaseFixVerify() {
  const checkoutPath: string = PAYLOAD.checkoutPath
  const beforeOids: Record<string, string> = PAYLOAD.beforeOids ?? {}
  const checkoutPaths: Record<string, string> = PAYLOAD.checkoutPaths ?? {}
  const touchedPaths: { occurrenceId: string; path: string }[] = []
  for (const [otherId, beforeOid] of Object.entries(beforeOids)) {
    const otherPath = checkoutPaths[otherId]
    const touched = new Set([...changedPathsSinceOid(otherPath, beforeOid), ...uncommittedChangedFiles(otherPath)])
    for (const path of touched) touchedPaths.push({ occurrenceId: otherId, path })
  }
  const ownCheckoutClean = uncommittedChangedFiles(checkoutPath).length === 0
  printResult({ ownCheckoutClean, touchedPaths })
}

function concreteMergeStageFailure(report: any): string {
  const explicit = typeof report.failureReason === 'string' ? report.failureReason.trim() : ''
  if (explicit) return explicit
  const occurrence = report.status === 'parent-conflicted' ? 'root' : (report.occurrenceId || 'unknown layer')
  const conflictSuffix = Array.isArray(report.conflictedFilePaths) && report.conflictedFilePaths.length > 0
    ? `; unresolved paths: ${report.conflictedFilePaths.join(', ')}`
    : ''
  const kind = report.stage === 'merge' ? 'merge failure' : report.stage === 'rebase' ? 'rebase conflict' : 'test failure'
  return `${kind} in ${occurrence} (${report.status})${conflictSuffix}`
}

function cleanupPlanAndBriefFiles(repoRoot: string) {
  const relativePaths = [`plans/task-${N}-plan.md`, `plans/brief-${N}.md`]
  execFileSync('git', ['-C', repoRoot, 'rm', '-f', '--ignore-unmatch', '--', ...relativePaths], { stdio: 'ignore' })
  for (const relativePath of relativePaths) {
    const absolutePath = join(repoRoot, relativePath)
    if (existsSync(absolutePath)) unlinkSync(absolutePath)
  }
  try {
    execFileSync('git', ['-C', repoRoot, 'diff', '--cached', '--quiet'], { stdio: 'ignore' })
  } catch {
    execFileSync('git', ['-C', repoRoot, 'commit', '-m', `task ${N}: remove plan and brief`], { stdio: 'ignore' })
  }
}

// A lost result after full success leaves no worktree to retry; reconstruct from the archive instead.
function findMergedTaskReceipt(sourceRoot: string, taskNumber: number): { status: 'merged'; mergedCommitHash: string; closed: number[] } | null {
  const pair = resolveTaskFiles(sourceRoot)
  const completed = readTaskFile(pair.completedTasksPath).find((entry: any) => entry.taskNumber === taskNumber)
  const commitHashes = completed?.commitHashes
  if (!Array.isArray(commitHashes) || commitHashes.length === 0) return null
  return { status: 'merged', mergedCommitHash: commitHashes[commitHashes.length - 1], closed: [taskNumber] }
}

type SourceSubmodule = { checkoutPath: string; depth: number }

// Shared by roleMerge's success tail, its already-closed recovery path, and roleCleanupOnly: never re-merges or re-closes.
function runFinalCleanup(repoRoot: string, mainRepoRoot: string, branch: string, sourceSubmodules: SourceSubmodule[]):
  { status: 'cleaned' } | { status: 'cleanup-incomplete'; cleanupWarning: string; retainedArtifacts: string[] } {
  try {
    // Cleanup order matters: a failure here leaves persistence refs for an idempotent retry.
    removeTaskWorktreeAndBranches(mainRepoRoot, repoRoot, branch, sourceSubmodules)
    deleteTaskMergePersistence(mainRepoRoot, branch)
    for (const target of sourceSubmodules) deleteTaskMergePersistence(target.checkoutPath, branch)
  } catch (error) {
    const cleanupWarning = `failed final branch/worktree cleanup: ${String((error as any)?.message ?? error)}`
    const retainedArtifacts = collectRetainedTaskArtifacts({
      worktreePath: repoRoot, leasePath: taskWorktreeLeasePath(repoRoot), mainRepoRoot, branch, sourceSubmodules,
    })
    return { status: 'cleanup-incomplete', cleanupWarning, retainedArtifacts }
  }
  releaseTaskWorktreeLease({ worktreePath: repoRoot, runId: RUN_ID })
  rmSync(advanceConflictReceiptsDir(repoRoot), { recursive: true, force: true })
  return { status: 'cleaned' }
}

function sourceSubmodulesFrom(manifest: ReturnType<typeof buildManifest>): SourceSubmodule[] {
  return manifest.repositoryManifest.occurrences
    .filter((occurrence: any) => occurrence.parentOccurrenceId !== null)
    .map((occurrence: any) => ({ checkoutPath: occurrence.checkoutPath, depth: occurrence.depth }))
}

// Mirrors runMerge from the pre-C86-18 task.workflow.js.
function roleMerge() {
  const repoRoot = WORKTREE
  const priorReceipt = findMergedTaskReceipt(SOURCE_ROOT, N)
  if (!existsSync(repoRoot)) {
    if (priorReceipt) { printResult(priorReceipt); return }
    fail(`task worktree ${repoRoot} no longer exists and task ${N} is not in completedTasks.json; cannot recover a merge receipt`)
  }
  if (priorReceipt) {
    // Already merged and closed by a prior attempt; only cleanup is outstanding.
    const manifest = buildManifest()
    const branch = currentBranchName(repoRoot)
    const cleanupOutcome = runFinalCleanup(repoRoot, SOURCE_ROOT, branch, sourceSubmodulesFrom(manifest))
    if (cleanupOutcome.status === 'cleanup-incomplete') {
      printResult({ ...priorReceipt, ...cleanupOutcome })
      return
    }
    printResult(priorReceipt)
    return
  }
  try {
    cleanupPlanAndBriefFiles(repoRoot)
  } catch (error) {
    printResult({ status: 'blocked', lastFailure: `cleanup failed: ${String((error as any)?.message ?? error)}` })
    return
  }
  const manifest = buildManifest()
  const rootOccurrence = manifest.repositoryManifest.occurrences.find((o: any) => o.occurrenceId === '')
  if (rootOccurrence.checkoutPath !== SOURCE_ROOT) {
    fail(`repositoryManifest root checkoutPath (${rootOccurrence.checkoutPath}) does not match sourceRoot (${SOURCE_ROOT})`)
  }
  const mainRepoRoot = SOURCE_ROOT
  const sourceBranch = rootOccurrence.baseBranch
  const sourceSubmodules = sourceSubmodulesFrom(manifest)
  const { stage: failedAtStage, ...report }: any = mergeTaskDeepestFirst(repoRoot, manifest)
  if (report.status !== 'merged') {
    printResult({ failedAtStage, ...report, lastFailure: concreteMergeStageFailure({ ...report, stage: failedAtStage }) })
    return
  }
  const rootLayer = report.completedLayers.find((layer: any) => layer.occurrenceId === 'root')
  const mergedCommitHash = rootLayer?.mergedCommitOid
  if (typeof mergedCommitHash !== 'string' || mergedCommitHash.length === 0) {
    printResult({ status: 'blocked', lastFailure: 'root merge-time commit record is missing; refusing to archive the current source tip' })
    return
  }
  const branch = currentBranchName(repoRoot)
  let closeResult
  try {
    closeResult = closeTasks([N], `merged to ${sourceBranch} at ${mergedCommitHash}`, mainRepoRoot, [mergedCommitHash])
  } catch (error) {
    const closeError = `close failure: ${String((error as any)?.message ?? error)}`
    printResult({ failedAtStage, ...report, status: 'merged-but-not-closed', mergedCommitHash, closeError, lastFailure: closeError })
    return
  }
  if (!closeResult.closed.includes(N)) {
    const closeError = `close failure: closeTasks did not close task ${N}: closed [${closeResult.closed.join(', ')}], skipped [${closeResult.skipped.join(', ')}], unblocked [${closeResult.unblocked.join(', ')}]`
    printResult({
      failedAtStage, ...report,
      status: 'merged-but-not-closed', mergedCommitHash,
      closed: closeResult.closed, skipped: closeResult.skipped, unblocked: closeResult.unblocked,
      closeError, lastFailure: closeError,
    })
    return
  }
  const cleanupOutcome = runFinalCleanup(repoRoot, mainRepoRoot, branch, sourceSubmodules)
  if (cleanupOutcome.status === 'cleanup-incomplete') {
    printResult({ failedAtStage, ...report, mergedCommitHash, closed: closeResult.closed, unblocked: closeResult.unblocked, ...cleanupOutcome })
    return
  }
  printResult({ failedAtStage, ...report, mergedCommitHash, closed: closeResult.closed, unblocked: closeResult.unblocked })
}

// Retries only final cleanup after a 'cleanup-incomplete' merge result; never re-merges or re-closes.
function roleCleanupOnly() {
  const repoRoot = WORKTREE
  const mainRepoRoot = SOURCE_ROOT
  const branch = `task-${N}`
  const manifest = buildManifest()
  const cleanupOutcome = runFinalCleanup(repoRoot, mainRepoRoot, branch, sourceSubmodulesFrom(manifest))
  printResult({ task: N, ...cleanupOutcome })
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const ROLE_HANDLERS: Record<string, () => void> = {
  'task-info': roleTaskInfo,
  'plan': rolePlan,
  'plan-file-status': rolePlanFileStatus,
  'widen-files': roleWidenFiles,
  'verify': roleVerify,
  'apply-feedback': roleApplyFeedback,
  'git-head': roleGitHead,
  'implement': roleImplement,
  'implement-finalize': roleImplementFinalize,
  'occurrence-oids': roleOccurrenceOids,
  'rebase-walk': roleRebaseWalk,
  'parent-rebase': roleParentRebase,
  'merge-conflict': roleMergeConflict,
  'conflict-identity': roleConflictIdentity,
  'advance-conflict': roleAdvanceConflict,
  'rebase-fix': roleRebaseFix,
  'rebase-fix-verify': roleRebaseFixVerify,
  'merge': roleMerge,
  'cleanup-only': roleCleanupOnly,
}

if (process.argv[1]?.endsWith('tackle-tasks_AgentPromptEmitter.ts')) {
  const handler = ROLE_HANDLERS[ROLE]
  if (!handler) fail(`unknown role "${ROLE}"`)
  handler()
}
