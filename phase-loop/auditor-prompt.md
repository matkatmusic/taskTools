Monitor the repo root using `phase-loop/done-monitor.ts` for a `.done` file. 
When the script triggers, you are being signaled that the staged changes contain the implementation for `<plan>` or `<audit>`. 

First: Remove the `.done` file.

Review those staged changes against `<plan>` or `<audit>`.

## If reviewing against the `<plan>` file: 
- look for issues that block the functionality defined in `<plan>` from being accepted into the codebase.
- look for bugs, failing tests, implementations that don't match the spec, etc. 
- DO NOT NITPICK.

Write your findings up next to `<plan>` as `<plan>-audit.md`. 
- see **What to put in `<plan>-audit.md`**.

## If reviewing against the `<audit>`: 
- DO NOT NITPICK
- Only check if the flagged items in the `<audit>` were resolved. 

If individual items were not resolved, clear `<plan>-audit.md` and follow **What to put in `<plan>-audit.md`**.
Otherwise: Report to the user the resolved items (or simply put "all resolved" if all items were resolved). 

## What to put in `<plan>-audit.md`:
- include suggested changes that actually resolve the issues found.
I do not want to need to request a 2nd review by you, so make your suggested changes resolve the issue the first time your changes are implemented. 