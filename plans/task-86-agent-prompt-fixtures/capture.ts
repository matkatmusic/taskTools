// Golden fixtures for task.workflow.js agent() prompts, for C86-18 diffing.  Run: node plans/task-86-agent-prompt-fixtures/capture.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const OUT_DIR = fileURLToPath(new URL('.', import.meta.url))

// Fixture top-level constants (mirrors task.workflow.js lines 1-9)
const N = 999
const TYPECHECK_COMMAND = 'npx tsc --noEmit'
const MAX_FIX_ROUNDS = 3

// --- verbatim copies of the brief-building functions from task.workflow.js ---

const fileRetryPreamble = (missingFiles: string[]) => `Before planning: the workflow has already widened this task's owned files in tasks.json to include ${missingFiles.join(', ')} and regenerated the brief file — you do not need to run any command for this. The owned-files list below already includes the paths you previously flagged as missing.

`

const testsInstruction = (t: any) => t.tests && t.tests !== 'skip'
  ? `The task's tests field holds an example test the user wrote — put it into the plan's verification section as the concrete check to run, expanded with a few extra cases covering the individual functions/subparts it touches: ${t.tests}`
  : 'This task has no tests field, or it is the literal string "skip" — do not require TDD; write ordinary verification commands in the plan instead.'

const worktreePath = (t: any, relativePath: string) => `${t.repoRoot.replace(/\/+$/, '')}/${relativePath}`

const shellQuote = (value: unknown) => `'${String(value).replaceAll("'", "'\"'\"'")}'`

const ownedPathMap = (t: any) => t.files
  .map((file: string) => `  - ${file} => ${worktreePath(t, file)}`)
  .join('\n')

const plannerBrief = (t: any, preamble = '') => `${preamble}Invoke /ponytail:ponytail ultra.
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

const codexPrompt = (t: any, planFile: string) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, replace the FIXES section with a "MISSING_FILES:" section instead: one repo-relative file path per line, the paths the plan would need read access to, and no other text in that section.`

const verifierBrief = (t: any, planFile: string) => {
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

const applyFeedbackBrief = (t: any, planFile: string, notes: string) => `Apply reviewer feedback to a plan file. The reviewer's PROBLEMS and FIXES are below, verbatim:

${notes}

Read ${planFile}, then edit it so it satisfies every fix listed above. The only file you may ever edit is ${planFile} — never touch a source file, the brief, or any other file, and never run any command.

If the text above has no FIXES section to apply (for example a MISSING_FILES section instead), make no edits and return applied false.

Return {task: ${t.number}, applied: true} once you have made the edits, or {task: ${t.number}, applied: false} if there was nothing to apply.`

const tddInstruction = (t: any) => t.tests && t.tests !== 'skip'
  ? `This task's tests field holds an example test the user wrote: ${t.tests}\nWrite that test first, then expand it to also cover the individual functions/subparts you build, before writing the implementation.`
  : 'This task has no tests field, or it is the literal string "skip" — skip TDD entirely and just write the code.'

const workerBrief = (t: any, note: string) => {
  const rootedTypecheck = `(cd -- ${shellQuote(t.repoRoot)} && ${TYPECHECK_COMMAND})`
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
while any test failed and fixRound is less than ${MAX_FIX_ROUNDS}:
    fixRound = fixRound + 1
    fix the cause
    typecheck = run(${rootedTypecheck})
    results = run every test command as (cd -- ${shellQuote(t.repoRoot)} && <test command>)

if any test still failed after ${MAX_FIX_ROUNDS} fix rounds:
    return {task: ${t.number}, status: "blocked", summary: what is still failing after ${MAX_FIX_ROUNDS} fix rounds, remaining: the failing test names, notesFile: notesFile}

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
commit while anything fails; to attempt more than ${MAX_FIX_ROUNDS} fix
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

// --- fixture data ---

const t = {
  number: N,
  repoRoot: '/fixture/repo/.taskTools/worktrees/task-999',
  briefFile: '/fixture/repo/.taskTools/worktrees/task-999/plans/brief-999.md',
  planFile: '/fixture/repo/.taskTools/worktrees/task-999/plans/task-999-plan.md',
  notesFile: '/fixture/repo/.taskTools/worktrees/task-999/plans/task-999-implementation-notes.md',
  files: ['scripts/exampleModule.ts', 'tests/exampleModule.test.ts'],
  tests: "node --test tests/exampleModule.test.ts",
}

const checkoutPath = '/fixture/repo/.taskTools/worktrees/task-999'

const fixtures: Record<string, string> = {
  'plannerBrief.txt': plannerBrief(t),
  'plannerBrief.withPreamble.txt': plannerBrief(t, fileRetryPreamble(['scripts/otherModule.ts'])),
  'verifierBrief.txt': verifierBrief(t, t.planFile),
  'applyFeedbackBrief.txt': applyFeedbackBrief(t, t.planFile, 'PROBLEMS:\nfixture problem text\n\nFIXES:\nfixture fix text'),
  'workerBrief.txt': workerBrief(t, ''),
  'workerBrief.withNote.txt': workerBrief(t, 'A previous worker finished part of this plan; still remaining: fixture remaining step.'),
  'mergeConflictBrief.txt': mergeConflictBrief(checkoutPath, ['scripts/exampleModule.ts', 'tests/exampleModule.test.ts']),
  'rebaseFixBrief.txt': rebaseFixBrief(checkoutPath, 'vendor/example-submodule', 'fixture test failure output\n  1 failing', ['vendor/example-submodule/vendor/nested-submodule']),
  'rebaseFixBrief.root.txt': rebaseFixBrief(checkoutPath, '', 'fixture test failure output\n  1 failing', []),
}

mkdirSync(OUT_DIR, { recursive: true })
for (const [name, content] of Object.entries(fixtures)) {
  writeFileSync(join(OUT_DIR, name), content, 'utf8')
}
process.stdout.write(`wrote ${Object.keys(fixtures).length} fixtures to ${OUT_DIR}\n`)
