# Task 84: Intercept /tackle-tasks with a hook that short-circuits a single blocked task and otherwise injects the generated skill body

## Goal

**This task is considered done when all of these are true:**

- every blocked task in the invocation prints one line per direct blocker: `[N] blocked by: M: <reason>`
- only direct blockers are printed, never the transitive chain
- after the blocked lines, one `run 'tackle-tasks [<blockers>] valid' first` line names the blockers
- the run then proceeds with only the unblocked task numbers, exactly as if they alone had been passed
- the same output format is used whether one task number or many were passed
- when no task is left unblocked, the hook prints the list and stops the run
- a prompt that is not a /tackle-tasks invocation exits 0 with no output

## User request

when 'tackle-task [<num>]' is used with a single task number, if that task is blocked, just output immediately "blocked by [N...]", before the dynamic injection even happens, if possible (hook catches the user input like the 'sync-jsonl-projects' hook does).  I'm not sure if this is possible because of the prose-approach to skills, but maybe we just have the skill turn into a hook, and the hook returns the error (no action) or returns the dynamically generated skill body that the agent then acts on.

**Feasibility: confirmed, and there is already a working precedent in this repo.** scripts/viewTaskHook.ts is a UserPromptSubmit hook that does exactly this shape today — it reads the hook payload as JSON from stdin via `readFileSync(0, "utf8")` (line 31), exits 0 silently unless the prompt starts with `/view-task` (line 36), resolves the task files from `payload.cwd` (38-41), and short-circuits by writing `JSON.stringify({ decision: "block", reason })` to stdout (line 48). It is registered in hooks/hooks.json under the `UserPromptSubmit` array as `node "${CLAUDE_PLUGIN_ROOT}/scripts/viewTaskHook.ts"`. Copy that structure.

**Harness facts verified against the Claude Code hooks documentation before writing this task:**
- UserPromptSubmit fires on the raw typed text, before slash-command/skill expansion, and therefore before any `!`cmd`` substitution inside a SKILL.md runs. So blocking here does prevent the skill's shell injections from executing — which is what the request hinges on.
- There is a second, purpose-built event, `UserPromptExpansion`, which fires specifically on the directly-typed `/skillname` path, matches on `command_name`, and receives `command_args`, `expansion_type`, `command_source` and the original `prompt`. It supports the same `{decision: "block", reason}` shape. Prefer it over string-matching the prompt text, unless matching the existing viewTaskHook.ts precedent is judged more valuable than the cleaner matcher — decide during implementation and say which and why.
- PreToolUse on the `Skill` tool is NOT usable here: it fires only when the model invokes the Skill tool, and is bypassed entirely when the user types `/tackle-tasks` directly.
- **Correction to the premise, and the one design constraint that shapes this task:** a UserPromptSubmit hook CANNOT replace prompt content. It can block, or it can add `hookSpecificOutput.additionalContext`, but it cannot rewrite the prompt. Also note `reason` is documented as shown to the USER and explicitly NOT added to context, while `additionalContext` IS added to context. The two can be emitted together in one JSON object. That combination is what makes the second half of the request work: block the expansion so SKILL.md never runs, and hand the agent the generated body through `additionalContext`. If the hook injected the body WITHOUT blocking, the agent would receive it twice — once as context and once from the skill expanding normally.

**Behaviour to build:**
1. Parse the task numbers out of the invocation the same way the rest of the toolchain does — `leadingTaskNumbers` in scripts/taskFiles.ts already implements the no-space JSON array convention (`[268,270,281]`).
2. Exactly one number, and that task is blocked: emit `{decision: "block", reason}` where `reason` is the COMPLETE transitive blocker sequence, not just the direct blockers, followed by the command that clears the front of it. For `/tackle-tasks [84] valid` the exact required stdout shape is:

```
[84] blocked by:
[62,70] <- [75] <- [84]
run 'tackle-tasks [62,70] valid' first
```

Read that chain right-to-left: 84 waits on 75, 75 waits on 62 and 70, and 62/70 have no open blockers. Rules for rendering it: walk `blockedBy` transitively, keeping only blockers that are still open; each `<-` step is one level of the walk; a level holding several tasks renders as a no-space JSON array (`[62,70]`), a level holding one task renders the same way (`[75]`) so the format is uniform; the leftmost level is the set of ROOT blockers — those with no open blockers of their own — and that is the set the final `run '...' first` line names. Collapse duplicates when two paths reach the same task, and guard against a cycle in `blockedBy` so the walk terminates and reports the cycle rather than hanging.

This is the one part that cannot simply reuse existing code: `openBlockersOf` in scripts/checkBlockers.ts (lines 13-17) resolves ONE level only. Either extend it into a transitive walk that returns the levelled chain and reuse it from both places, or write the walk in the hook script; extending the shared function is preferred so `checkBlockers.ts` and the hook cannot disagree about what blocks what.
3. Exactly one number, not blocked: emit the dynamically generated skill body as `additionalContext`, with `decision: "block"` so the SKILL.md does not also expand.
4. More than one number: pass through unchanged, exit 0 silently. Multi-task runs keep today's behaviour — checkBlockers reports per-task status and the skill skips the blocked ones. Decided explicitly; do not add an all-blocked special case.
5. Any prompt that is not a /tackle-tasks invocation: exit 0 silently, like viewTaskHook.ts:36.

**Where the body comes from.** Task #75 moves the tackle-tasks SKILL.md body into scripts/tackleTasksBrief.ts, which emits exactly the text this hook needs to inject. This task consumes that script rather than generating the body a second time, which is why it is blocked on #75. #75 is in turn blocked by #62 and #70, and open task #82 should also land before #75 so the two-step plan/verify wording is already gone from the body.

**Note on the referenced precedent:** the user cites a `sync-jsonl-projects` hook. That belongs to a different plugin (jfredToolsPlugin) and is not present in this repository; scripts/viewTaskHook.ts is the in-repo equivalent and is the one to copy.

hooks/hooks.json currently registers UserPromptSubmit, PostToolUse (Edit|Write|NotebookEdit), Stop, SubagentStop and SessionEnd. Adding a second UserPromptSubmit entry alongside viewTaskHook.ts is the straightforward wiring; if `UserPromptExpansion` is chosen instead, a new top-level event array is needed.

**AMENDMENT (user, 2026-08-08) — supersedes the "Behaviour to build" points 2 and 4 above.**

The `goal` field on this task is authoritative. Where it disagrees with the prose above, follow the goal.

Two decisions changed:

1. **Multi-task invocations no longer pass through silently.** Point 4 above is withdrawn. Given tasks 2,3,4,5,8,12 where 3 and 5 are blocked by 2, `tackle-tasks [3,4,5,8,12]` must print:

```
[3] blocked by: 2: <reason>
[5] blocked by: 2: <reason>
run 'tackle-tasks [2] valid' first
```

and then continue exactly as if `tackle-tasks [4,8,12] valid` had been typed. When every requested task is blocked, print the list and the run line and stop.

2. **Direct blockers only — the transitive chain renderer is withdrawn.** Point 2's three-line `[62,70] <- [75] <- [84]` format is NOT built. There is ONE output format, used whether one task number or many were passed: one `[N] blocked by: M: <reason>` line per blocked task per direct blocker, then the single `run '...' first` line after the whole list. Because only one level is walked, `openBlockersOf` in scripts/checkBlockers.ts already does the resolution needed — no transitive walk, and therefore no cycle guard, is required.

## Files

### scripts/tackleTasksHook.ts

(missing: file not found on disk)

@hooks/hooks.json
### tests/tackleTasksHook.test.ts

(missing: file not found on disk)

@scripts/viewTaskHook.ts
@scripts/checkBlockers.ts
@scripts/taskFiles.ts
@scripts/tackleTasksBrief.ts