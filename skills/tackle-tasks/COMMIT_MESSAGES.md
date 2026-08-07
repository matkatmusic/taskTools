If you made any changes to the codebase — which may span multiple git repos or submodules — stage the changes in each affected repo, but do not commit in any of them. Then generate one commit message per repo:

Use a single subagent running `Sonnet 5` (fall back to `Opus 5` if Sonnet is unavailable or errors): pass it the path of every repo or submodule in which the caller staged changes — not diff contents — and instruct it to run the collection itself, at the moment it starts: for each supplied repo path, run `git -C <repo> diff --staged -- ':(exclude)*tasks.json' ':(exclude)*completedTasks.json' ':(exclude)plans/archived'` immediately, treating a repo as affected only if that command produces a nonempty diff, and also run `git -C <repo> diff --staged --raw -- ':(exclude)*tasks.json' ':(exclude)*completedTasks.json' ':(exclude)plans/archived'` on each affected repo and treat any line whose old or new file mode is `160000` as a moved submodule pointer — and have it generate, per affected repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
A parent repo whose only change is a submodule pointer counts as an affected repo — its message should name the submodule being updated and why.

Report the summaries to the user, one line per repo, in the following format:
```
Repo: <repo name> 
Message: <summary>
```
