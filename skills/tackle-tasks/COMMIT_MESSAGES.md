If you made any changes to the codebase — which may span multiple git repos or submodules — stage the changes in each affected repo, but do not commit in any of them. Then generate one commit message per repo:

Use a single subagent running `Sonnet 5` (fall back to `Opus 5` if Sonnet is unavailable or errors): give it the staged diff of every affected repo — collected after staging with `git -C <repo> diff --staged -- ':(exclude)*tasks.json' ':(exclude)*completedTasks.json' ':(exclude)plans/archived'` — and have it generate, per repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
A parent repo whose only change is a submodule pointer counts as an affected repo — its message should name the submodule being updated and why.

Report the summaries to the user, one line per repo, in the following format:
```
Repo: <repo name> 
Message: <summary>
```
