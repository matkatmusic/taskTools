## YOUR JOB

A rebase inside ``${root}`` is stopped on live conflict markers. 
It is stopped, not aborted, so the markers are still in the files.
Resolve every conflict in the files listed under WHAT YOU MAY EDIT, and nothing else.

## WHAT TO READ

Run this, verbatim:
```
/read-file `${readFileArgs(absolutePaths)}`
```
This skill puts the files into your context without spending a Read tool call, so you can read them all at once.

You may read any other file, anywhere in the tree, to understand a conflict: callers, callees, tests, other layers.

`${absolutePathsSection(root)}`

## WHAT YOU MAY EDIT

`${absolutePaths.map((path) => `- \`${path}\`` ).join("\n")}`

You may also edit a file in a DIFFERENT repository when resolving a conflict requires it. 
Resolving a conflict often means updating a call site, and a call site can live in another repository.

This list is complete.
Never search the repository for more conflicted files.

`${resumedRunSection(root)}`

## HOW TO RESOLVE

For each file listed above:
1. Find every `<<<<<<<`, `=======` and `>>>>>>>` block.
2. Combine the two sides so both sides' intent survives.
3. Delete the three marker lines.

## DO NOT DRIVE THE REBASE

Never run `git rebase --continue` or `git rebase --abort`. 
A later box advances the rebase after you return.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- weaken, delete, or stub out code to make a conflict disappear;
- keep one side and discard the other when both sides carry intent;
- edit a file that is not listed above and is not a call site a listed conflict forces you to update;
- force-push or hard-reset anything you did not create;
- run `git rebase --continue` or `git rebase --abort`;
- stage or commit anything by hand;
- leave a required edit in another repository unmade.

Returning `resolved: false` is a correct outcome when a conflict genuinely cannot be resolved.
It is not a failure, and it is always better than a guess.

`${whatToReturnSection(...)}`