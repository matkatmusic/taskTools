Fix the following issues that will be presented by running a command in Bash()

Capture the output of the following Bash() command in a temp file. 

`jq '.issues[] | select(.number == X or .number == Y or ...)' plans/task-86-codex-audit.json`

Read the temp file. 
Create a task list for the issues. 
Implement the specified fixes described in the `.suggestedFixApproach` so that `.provingTest` passes. 
Follow the prescribed fixes.  You should not need to do more work beyond what is prescribed to resolve the issue.

Typecheck with `npx tsc --noemit`.
Fix typecheck issues before testing. 
Test with: `npm test 2>&1 | rg -e '^✖' || echo "all passing"`.
if any tests fail, use `npm test 2>&1 | tail - 80` to identify the first test that needs fixing and fix it, then test again with the first test command that prints out 'all passing'. 

When you are done, stage only your changes.
