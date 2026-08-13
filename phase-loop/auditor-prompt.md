Monitor the repo root using `phase-loop/done-monitor.ts` for a `.done` file. 
When the script triggers, you are being signaled that the staged changes contain the implementation for `<plan>` or `<audit>`. 

remove the `.done` file first. 

Review those staged changes against the `<plan>` or audit.
If reviewing against the `<plan>` file: 
- look for issues that block the functionality defined in the `<plan>` from being accepted into the codebase.
- look for 
- include suggested changes that actually resolve the issues found.
- DO NOT NITPICK.
- Write your findings up next to `<plan>` as `<plan>-audit.md`. 
I do not want to need to request a 2nd review by you, so make your suggested changes resolve the issue the first time your changes are implemented. 

If reviewing against the `<audit>`: 
- DO NOT NITPICK
- Only check if the flagged items in the audit were resolved. 