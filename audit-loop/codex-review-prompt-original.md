Workflow sequence: 
START:
- Sonnet implements Tasks (commit)
- Codex audits codebase against spec for tasks. (commit requested changes only)
LOOP:
- Sonnet fixes audit item X... (stage only)
- Codex reviews staged only against audit item X...
- - no fixes: remove audit item X... entry and stage audit file. Go to CLOSE
- - fixes: unstage all, update audit item X... and stage audit file only (commit). go to LOOP.
CLOSE:
- Commit staged only. 
- update audit file against codebase.
- If audit file is not empty:
- - Pick new item X... 
- - go to LOOP. 

## LOOP Codex Review instructions: 
Compare codex-audit.json items X Y against the staged changes in the codebase.  
Do not nitpick. 

## LOOP - No fixes needed
If the items were resolved completely, remove them from the codex-audit.json and add your changes to codex-audit.json. to the list of staged files.  Do not nitpick.

## LOOP - Fixes needed
If an item was partly resolved, remove the resolved sections from the item. 
Unstage all staged changes.  
Any changes to codex-audit.json because of fixes being needed result in only the codex-audit.json changes been committed. 
 
Update the item's key's values so that the item can be correctly resolved by a separate agent. 
Do not nitpick.
If an item was not resolved, rewrite the item and clearly state the cause and the solution, as defined in plans/task-86-codex-audit-schema.md
Stage only the codex-audit.json changes you made.  

## CLOSE Update audit file instructions: 
Check if the fixes from audit items Y... are accurate and current against the latest revision of the codebase, now that audit items X... have been resolved.   
Amend the audit items Y... if necessary, otherwise say "Audit is accurate".  
If amending is needed, follow the guidelines in codex-audit-schema.md. 
