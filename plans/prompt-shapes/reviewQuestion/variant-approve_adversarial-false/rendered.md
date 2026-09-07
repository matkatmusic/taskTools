Approve the plan. Do not judge it, do not hunt for problems, and do not flag anything.

Return the JSON shape described below with `outcome` set to "OK", with `missingFiles`, `message`, `issues` and `fixes` all empty, and with every section `id` the plan uses listed in `sectionsThatHoldUp`.

## WHAT YOU READ

- /tmp/fake-worktree/plans/brief-99.md
- /tmp/fake-worktree/plans/plan.json
- /Users/matkatmusicllc/Programming/taskTools-86/plans/review-plan-template.json

## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by `/Users/matkatmusicllc/Programming/taskTools-86/plans/review-plan-template.json`, which you read above,
replacing every <...> with a real value.

## WHAT TO OUTPUT 

Print the JSON as your final message and nothing else. The command that runs you captures that
message to `/tmp/fake-worktree/plans/codex-review.json`, so do not try to write the file yourself.

