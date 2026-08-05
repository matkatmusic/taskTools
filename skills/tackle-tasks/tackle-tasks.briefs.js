export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    notes: { type: 'string' },
  },
  required: ['task', 'verdict', 'notes'],
}

export const TEST_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task: { type: 'integer' }, detail: { type: 'string' } },
        required: ['task', 'detail'],
      },
    },
  },
  required: ['passed', 'failures'],
}

export const plannerBrief = (t) => `Invoke /ponytail:ponytail ultra.
Read ONLY this brief file (do not read any other file): ${t.briefFile}
Follow ~/.claude/guides/planning.md and write the plan to exactly this path: ${t.planFile}
Do not change any source file — this is planning only, not implementation.
If the task is unclear, set status "needs-clarification" and put your
question in "question". If the task no longer applies to the codebase, set
status "not-relevant" and explain why in "question". Otherwise write the
plan file and set status "planned".
Return {task: ${t.number}, status, planFile: "${t.planFile}", question}.`

export const verifierBrief = (t, planFile) => `Read ONLY these two files: the
brief ${t.briefFile} and the plan ${planFile}. Do not read any other file, do
not run any command, do not change anything — this is a plan review, not an
implementation step.

Check whether the plan is good enough to hand to an implementer: it stays
within the task's owned files (${t.files.join(', ')}), it gives concrete
steps rather than open design questions, and someone could follow it without
having to decide anything the plan should have already decided.

If it holds up, verdict "approved". If it's vague, out of scope, or would
leave the implementer guessing, verdict "rejected" and say exactly why in
notes — that reason is the only thing anyone will see before the task is
skipped.
Return {task: ${t.number}, verdict, notes}.`

export const workerBrief = (t, group, planFile, note, typecheckCommand) => `You are implementing EXACTLY ONE pre-planned task: #${t.number}.
Repo root (cd here first): ${group.worktree}
Plan file: ${planFile}
Files you own (touch nothing outside them): ${t.files.join(', ')}
${note}
Read the plan file, then implement it exactly — no scope additions, no
refactors the plan doesn't call for. All design decisions were made in the
plan; you are executing, not deciding. If the plan is impossible as written,
stop and return status "blocked" with the reason in summary.

When the edits are done, run: ${typecheckCommand}
Fix type errors in the files you own.

Then run the tests covering the files you own and fix any failures — check
for a related-test discovery command in this repo (e.g. scripts/relatedTests.ts)
before falling back to running each owned file's own test file directly. Do
not run the full suite; that is the close-tasks gate, not yours.

If your tests still fail after a reasonable effort, do not commit. Return
status "blocked" (or "partial" if part of the plan is done) and name the
failing tests in "remaining" — never return status "done" with a failing test.

When typecheck passes, commit from ${group.worktree}. Other tasks may share
this worktree, so stage ONLY your own paths — never \`git add -A\`, never \`git add .\`:
  ${t.files.length ? `git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}` : 'git add -- <list every path you edited, explicitly>'}
  git commit -m "task ${t.number}: <one-line summary>"

Soft time budget: 10 minutes — if you cannot finish, stop and return status
"partial" with the not-yet-done plan steps listed in "remaining".
Return {task: ${t.number}, status, summary (one sentence), remaining}.`

export const testerBrief = (group, doneTasks) => `cd ${group.worktree}.
The following tasks just committed changes to these files:
${doneTasks.map((t) => `- task ${t.number}: ${t.files.join(', ')}`).join('\n')}

Report only — do not edit any file. Find and run the tests covering these
files: check for a related-test discovery command in this repo (e.g.
scripts/relatedTests.ts) before falling back to running each file's own test
file directly. Do not run the full suite.

Return passed=true only if every discovered test passes. Otherwise
passed=false and, for each task whose files have a failing test, add an
entry to failures: {task: <task number>, detail: <failing test names and a
short error summary>}.
Return {passed, failures}.`
