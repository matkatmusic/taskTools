# Task 107: Inject the staged diff into the commit-message subagent's own prompt instead of the skill body

## Goal

**This task is considered done when all of these are true:**

- a new commit-message workflow file runs stagedDiffs.ts and pastes its output into the subagent's prompt body
- the staged diff never enters the orchestrating agent's context
- the skill body no longer runs stagedDiffs.ts with a `!` command
- the subagent still covers the root repo plus every submodule whose pointer moved
- the `Repo:` / `Message:` output format is unchanged

## User request

inject the diff directly into the subagents prompt

skills/commit-message/SKILL.md:8 runs `!`node "${CLAUDE_PLUGIN_ROOT}/scripts/stagedDiffs.ts"`` in the skill body, so the full staged diff is expanded into the ORCHESTRATING agent's context. Line 10 then tells that agent to "pass it the diffs above" to a single Sonnet 5 subagent. The whole diff is therefore paid for twice — once in the main context, once in the subagent's — and the main agent, having read it, is positioned to write the message itself rather than delegating.

This is a regression of already-completed work. Task 61 ("Have the commit-message subagent collect the staged diff itself instead of receiving it from the main agent", closed 2026-08-06) explicitly moved diff collection into the subagent. Task 62 ("Convert COMMIT_MESSAGES.md into a skill so the staged diff is injected into its body at invocation time", closed 2026-08-07) then re-introduced body injection, undoing 61's benefit. The skill is the survivor, so the fix belongs in the skill rather than by reverting 62.

Fix shape: drop the `!` command from the skill body and instead inline the command into the subagent's prompt, so the subagent runs `scripts/stagedDiffs.ts` itself with Bash and the bytes never enter the orchestrator. There is a working precedent for exactly this move in this repo — commit 72a6c40 rewrote the planner's missing-files retry to inline its commands into the agent's own prompt instead of running them with execFileSync, and skills/tackle-tasks/plan.workflow.js:24-34 shows the resulting prompt shape.

Constraint to preserve: the subagent must still be told which repos to cover. stagedDiffs.ts already walks the root repo plus every submodule with a moved pointer (stagedDiffs.ts:26-48) and labels each section `=== label ===`, so having the subagent run the script keeps that behaviour without the orchestrator enumerating repos. SKILL.md:11 (a parent repo whose only change is a submodule pointer counts as an affected repo) and SKILL.md:13-17 (the `Repo:` / `Message:` output format) must survive the rewrite unchanged.

**AMENDMENT (user, 2026-08-08) — supersedes the "Fix shape" paragraph above.**

The `goal` field on this task is authoritative. The fix is NOT "inline the command into the subagent's prompt so the subagent runs stagedDiffs.ts itself".

Instead, add a workflow file for commit-message that mirrors how skills/tackle-tasks/plan.workflow.js builds its planner prompt: the workflow runs `scripts/stagedDiffs.ts` in JavaScript and pastes the resulting diff text **directly into the subagent's prompt body**, so the subagent reads the diff contents rather than a pointer or an instruction to fetch them. The orchestrating agent never sees the diff, because the prompt string is assembled outside its context.

The skill body therefore drops its `!` command and shrinks to an instruction to launch that workflow. The constraints already stated survive unchanged: the root repo plus every submodule with a moved pointer must be covered, and the `Repo:` / `Message:` output format at SKILL.md:13-17 is untouched.

The task's `files` list must be widened to include the new workflow file.

## Files

@skills/commit-message/SKILL.md
@skills/tackle-tasks/plan.workflow.js
@skills/tackle-tasks/SKILL.md
@scripts/stagedDiffs.ts
@scripts/tackleTasksBrief.ts
### skills/commit-message/commitMessage.workflow.js

(missing: file not found on disk)
