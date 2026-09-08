# Amendment: Task 21 plan — static test: no hook script is registered twice for one overlapping event

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/21-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/21.json, the live codebase, and the official Claude Code hooks reference
Sections: 5 | Fixes: 3
Efficacy: 40%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/21-task.md must be amended with the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. Matcher overlap is not pipe-delimited set intersection

- Evidence: `[hooks/hooks.json:30-73, plans/pipeline-audit-20260905-114658/21-task.md:159-174]`
- The plan claims: splitting both matchers on `|` and intersecting the resulting strings decides whether their scopes overlap.
- Actually true: Claude hook matchers are regular expressions, including patterns such as `mcp__.*__write.*`; alternation is only one regex feature. The proposed function produces false negatives for intersecting regexes and false positives for escaped alternation or grouped expressions. The official reference defines matcher as a regex string: https://code.claude.com/docs/en/hooks#matcher-patterns.

### 2. The command normalizer is not a command parser and conflates different paths

- Evidence: `[hooks/hooks.json:6-25, hooks/hooks.json:34-70, plans/pipeline-audit-20260905-114658/21-task.md:145-157]`
- The plan claims: whitespace splitting, selecting the first non-flag token after `node`, and taking `basename` reliably identifies the executed script.
- Actually true: quoted paths containing spaces split into multiple tokens, Node flags can consume a following value, wrappers need not be `node`, and two distinct directories can legitimately contain the same basename. The function can therefore both miss a duplicate and report unrelated scripts as duplicates—the opposite of a trustworthy static gate.

### 3. Two repository files are not Claude's merged runtime configuration

- Evidence: `[.claude/settings.json:1-6, hooks/hooks.json:1-114, tests/hookInstalled.test.ts:8-26, plans/pipeline-audit-20260905-114658/21-task.md:121-136]`
- The plan claims: concatenating `.claude/settings.json` and the plugin's `hooks/hooks.json` loads the merged configuration sources Claude Code actually reads for a target project.
- Actually true: that only reads this development checkout's project settings and shipped plugin hooks. Claude's effective hook inventory can also contain user, local, managed, other-plugin, and in-memory session registrations. The official hook browser documents those sources and runtime deduplication: https://code.claude.com/docs/en/hooks#the-hooks-menu. The proposed test cannot support its global claim or catch collisions introduced at installation time.

## Durable fixes

### Fix for issue 1

- Change: Define a conservative regex-aware policy. Exact literal alternations may use set intersection; unconditional matchers overlap everything; arbitrary regex pairs must be treated as potentially overlapping unless a real regex-intersection implementation proves them disjoint. Add grouped, escaped, wildcard MCP, anchored, and literal-alternation tests.
- Durable because: new valid matcher syntax cannot silently evade the duplicate guard merely because it is not a flat list of tool names.

### Fix for issue 2

- Change: Canonicalize a full script identity, not a basename, with a tested shell-tokenizer or a deliberately constrained command grammar that rejects unsupported forms. Expand recognized root variables to a stable marker, preserve the repo-relative directory, account for flags with operands, and add tests for spaces, escaping, wrappers, and identical basenames in different directories.
- Durable because: identity follows the executable script path without guessing from lossy whitespace tokens.

### Fix for issue 3

- Change: Rename the repository test so it truthfully guarantees only the checked-in project-plus-plugin sources. If the task must guarantee the target project's effective configuration, add an installation/runtime acceptance step that obtains Claude's effective hook inventory (including source and matcher, as exposed by `/hooks` or an equivalent supported interface) and feeds that inventory to the pure duplicate checker. Do not label concatenated raw JSON as merged runtime state.
- Durable because: the static invariant and the installation-time invariant are explicit, separately testable, and cannot give a false assurance about unseen configuration layers.

## Sections that hold up

- Same script on different events is intentional and must not be flagged — verified against `hooks/hooks.json:3-29`, `hooks/hooks.json:41-73`, and `scripts/taskTestsHook.ts:13-23`
- The current shipped plugin file contains no same-event duplicate script — verified against `hooks/hooks.json:1-114`
- Keeping detection in a pure helper plus a static test is appropriate for the checked-in-source invariant — verified against `tests/hookInstalled.test.ts:1-26`
