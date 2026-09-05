# Task 21 plan — static test: no hook script is registered twice for one overlapping event

## Scope confirmation

- `hooks/hooks.json` — read in full. Structure: `{ hooks: { <EventName>: [ { matcher?: string, hooks: [ { type: "command", command: string, timeout?: number, ... } ] } ] } }`. `PreToolUse` and `PostToolUse` groups carry a `matcher` (e.g. `"Edit|Write|NotebookEdit"`, `"Skill"`); `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionEnd` groups carry no `matcher` key at all, meaning unconditional for that event. A `matcher` is a regex string in general (grouping, anchors, and wildcards such as `mcp__.*__write.*` are all valid), not only a plain `|`-joined list of tool names — this repo's own matchers happen to be plain lists today, but the duplicate check must not assume every project's are.
- `.claude/settings.json` — this repo's own project settings; may also carry a `hooks` key alongside `hooks/hooks.json`. This task's new test reads only these two checked-in files. Claude Code's actual effective hook inventory for a running session can also include user, local, managed, other-plugin, and in-memory session registrations this test cannot see — so the test asserts only that this repository's own checked-in configuration carries no self-inflicted duplicate, not that no duplicate can exist anywhere in a live session.
- `scripts/taskTestsHook.ts`, lines 13–23, confirmed live:
  ```ts
  // Plugin skills reach the hook namespaced, as /taskTools:task-tests and taskTools:task-tests.
  const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
  const input = payload.tool_input ?? {};
  const skill = String(input.skill ?? "").replace(/^[\w-]+:/, "");

  const args = prompt === "/task-tests" || prompt.startsWith("/task-tests ")
      ? prompt.slice("/task-tests".length).trim()
      : skill === "task-tests"
          ? String(input.args ?? "").trim()
          : undefined;
  if (args === undefined) process.exit(0);
  ```
  This one script is registered on two different events — `UserPromptSubmit` (handles a typed `/task-tests` prompt) and `PostToolUse:Skill` (handles a Skill-tool call) — and its own code branches on which shape of payload arrived. This is the "intended two-event registration" the new test must never flag: same script, same `taskTestsHook.ts` identity, but different `event` values (`UserPromptSubmit` vs `PostToolUse`), so it is not a same-event duplicate under any definition.
  `runStepHook.ts` is registered the same way (`UserPromptSubmit` and `PostToolUse:Skill`), confirmed by `tests/hookInstalled.test.ts`, which already asserts both registrations exist by name — this task's new test must not contradict that one.
- Current command strings a script-identity function must handle correctly (confirmed via `cat hooks/hooks.json`):
  - `node "${CLAUDE_PLUGIN_ROOT}/scripts/viewTaskHook.ts"` (no flag)
  - `node --no-inspect "${CLAUDE_PLUGIN_ROOT}/scripts/readFileHook.ts"` (flag + quoted root variable)
  - `node --no-inspect "${CLAUDE_PLUGIN_ROOT}/scripts/turn-modified-flag.ts" --snapshot 2>/dev/null || true` (flag, quoted root variable, a script argument, and a shell fallback trailing the command)
  Every command in this file starts with a literal `node`, takes at most boolean `--flag` tokens (no flag with its own operand), and quotes its script path — this is the one shape the identity function needs to recognize; a command in some other shape (a different wrapper, an unquoted path with spaces) should be rejected rather than guessed at, since a wrong guess can hide a real duplicate or invent a false one. A basename-only identity would also wrongly equate two different scripts that happen to share a filename in different directories, and would not equate `${CLAUDE_PLUGIN_ROOT}/scripts/x.ts` with the same script spelled as its resolved absolute path — both are corrected in Step 2's design.
  No two currently-registered commands in `hooks/hooks.json` actually collide today (`PreToolUse:Edit|Write|NotebookEdit` has one hook; `PostToolUse:Edit|Write|NotebookEdit` has two, distinct scripts; `UserPromptSubmit` has five, all distinct; `PostToolUse:Skill` has three, all distinct; `Stop` has two, distinct scripts; `SubagentStop` and `SessionEnd` have one each) — this task is a regression guard, not a fix for an existing collision. This file is live and can change between reads (confirmed current via `cat hooks/hooks.json` immediately before writing this plan) — the exact counts are informational, not something the new test hardcodes.
- `tests/hookInstalled.test.ts` — read in full (26 lines). Existing model for loading this repo's own checked-in hook configuration:
  ```ts
  const FILES = [".claude/settings.json", "hooks/hooks.json"];
  function isRegistered(event: string, matcher?: string) {
      return FILES
          .filter(file => existsSync(join(ROOT, file)))
          .map(file => JSON.parse(readFileSync(join(ROOT, file), "utf8")))
          .flatMap(config => config.hooks?.[event] ?? [])
          .filter(group => group.matcher === matcher)
          .flatMap(group => group.hooks ?? [])
          .some(hook => hook.type === "command" && hook.command.includes("runStepHook.ts"));
  }
  ```
  This task's new test file does not import from or edit this file — it asserts a different property (no duplicate registration, vs. this file's "this one script is registered") — but reuses the same two-file loading approach, duplicated locally rather than extracted into a shared helper (the duplication is a few lines; extracting a shared loader for two call sites is not requested and is not this task's job).
- No production code changes: this task is a static test only, per the session task's own framing ("Static test: no hook script is registered twice for one event") and the audit's ("Medium: task 21's duplicate definition is too weak"). Verifying Claude Code's actual merged runtime hook inventory (user, local, managed, other-plugin, and in-memory session sources) would need a live-session acceptance step outside `node --test`, which is a different task from the one this session task defines — out of scope here, not attempted.

## Steps

### Step 1 — red: write the pure-logic tests first

Create `tests/hookDuplicateRegistration.test.ts`. Write the normalization and overlap-detection tests before the functions exist:

```ts
// No hook script is registered twice for one event and overlapping matcher scope.  Run alone: node --test tests/hookDuplicateRegistration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCommandIdentity, matchersOverlap, findDuplicateRegistrations, type HookRegistration } from "../scripts/hookRegistrationAudit.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILES = [".claude/settings.json", "hooks/hooks.json"];

test("test_normalizeCommandIdentityStripsNodeFlagsAndTheRootVariable", () => {
    // Plain-English step: two commands for the same script, one with a flag, must normalize to the same identity.
    assert.equal(normalizeCommandIdentity('node "${CLAUDE_PLUGIN_ROOT}/scripts/runStepHook.ts"'), "<root>/scripts/runStepHook.ts");
    assert.equal(normalizeCommandIdentity('node --no-inspect "${CLAUDE_PLUGIN_ROOT}/scripts/runStepHook.ts"'), "<root>/scripts/runStepHook.ts");
});

test("test_normalizeCommandIdentityIgnoresTrailingArgumentsAndShellFallback", () => {
    // Plain-English step: a script's own argument and a trailing `|| true` must not change its identity.
    const command = 'node --no-inspect "${CLAUDE_PLUGIN_ROOT}/scripts/turn-modified-flag.ts" --snapshot 2>/dev/null || true';
    assert.equal(normalizeCommandIdentity(command), "<root>/scripts/turn-modified-flag.ts");
});

test("test_normalizeCommandIdentityDistinguishesTwoScriptsWithTheSameBasenameInDifferentDirectories", () => {
    // Plain-English step: two different directories can share a filename; identity must keep the full path, not just the basename.
    assert.notEqual(
        normalizeCommandIdentity('node "${CLAUDE_PLUGIN_ROOT}/scripts/a/x.ts"'),
        normalizeCommandIdentity('node "${CLAUDE_PLUGIN_ROOT}/scripts/b/x.ts"'),
    );
});

test("test_normalizeCommandIdentityTreatsAResolvedAbsolutePathTheSameAsTheRootVariable", () => {
    // Plain-English step: the same script spelled with a literal checkout path must match the ${CLAUDE_PLUGIN_ROOT} spelling.
    const viaVariable = normalizeCommandIdentity('node "${CLAUDE_PLUGIN_ROOT}/scripts/runStepHook.ts"');
    const viaResolvedPath = normalizeCommandIdentity(`node "${ROOT}/scripts/runStepHook.ts"`);
    assert.equal(viaVariable, viaResolvedPath);
});

test("test_normalizeCommandIdentityThrowsForACommandThatIsNotARecognizedNodeScriptShape", () => {
    // Plain-English step: a command this grammar cannot canonicalize must throw, not guess at an identity.
    assert.throws(() => normalizeCommandIdentity("bash script.sh"));
});

test("test_matchersOverlapWhenBothAreAbsent", () => {
    // Plain-English step: two registrations with no matcher key (e.g. two UserPromptSubmit hooks) always overlap.
    assert.equal(matchersOverlap(undefined, undefined), true);
});

test("test_matchersOverlapWhenOneIsAbsent", () => {
    // Plain-English step: no matcher means "every tool"; it overlaps any specific matcher.
    assert.equal(matchersOverlap(undefined, "Skill"), true);
});

test("test_matchersDoNotOverlapWhenToolListsAreDisjoint", () => {
    // Plain-English step: "Edit|Write" and "Skill" name no tool in common.
    assert.equal(matchersOverlap("Edit|Write", "Skill"), false);
});

test("test_matchersOverlapWhenToolListsShareAName", () => {
    // Plain-English step: "Edit|Write|NotebookEdit" and "Write|NotebookEdit" share "Write".
    assert.equal(matchersOverlap("Edit|Write|NotebookEdit", "Write|NotebookEdit"), true);
});

test("test_matchersOverlapConservativelyForAWildcardMcpMatcherEvenWithNoLiteralOverlap", () => {
    // Plain-English step: "mcp__.*__write.*" is a real regex, not a literal list; it cannot be proven disjoint from "Skill".
    assert.equal(matchersOverlap("mcp__.*__write.*", "Skill"), true);
});

test("test_matchersOverlapConservativelyForAnAnchoredRegex", () => {
    // Plain-English step: "^Edit$" is anchored, not a plain literal alternation; treat it as possibly overlapping.
    assert.equal(matchersOverlap("^Edit$", "Write"), true);
});

test("test_matchersOverlapConservativelyForAGroupedOrEscapedPattern", () => {
    // Plain-English step: "(Edit|Write)" uses grouping; treat it as possibly overlapping rather than guessing at its meaning.
    assert.equal(matchersOverlap("(Edit|Write)", "Skill"), true);
});

test("test_findDuplicateRegistrationsFlagsTwoScriptsOnTheSameEventAndOverlappingMatcher", () => {
    // Plain-English step: the same script twice on the same event with overlapping matchers is a real duplicate.
    const registrations: HookRegistration[] = [
        { event: "PostToolUse", matcher: "Edit|Write", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/x.ts"' },
        { event: "PostToolUse", matcher: "Write|NotebookEdit", command: 'node --no-inspect "${CLAUDE_PLUGIN_ROOT}/scripts/x.ts"' },
    ];
    assert.equal(findDuplicateRegistrations(registrations).length, 1);
});

test("test_findDuplicateRegistrationsIgnoresTheIntendedTwoEventRegistration", () => {
    // Plain-English step: taskTestsHook.ts on UserPromptSubmit and PostToolUse:Skill must never be flagged.
    const registrations: HookRegistration[] = [
        { event: "UserPromptSubmit", matcher: undefined, command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/taskTestsHook.ts"' },
        { event: "PostToolUse", matcher: "Skill", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/taskTestsHook.ts"' },
    ];
    assert.deepEqual(findDuplicateRegistrations(registrations), []);
});

test("test_findDuplicateRegistrationsIgnoresDisjointMatchersOnTheSameEvent", () => {
    // Plain-English step: same event, same script, but matchers that name no tool in common.
    const registrations: HookRegistration[] = [
        { event: "PostToolUse", matcher: "Edit", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/y.ts"' },
        { event: "PostToolUse", matcher: "Skill", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/y.ts"' },
    ];
    assert.deepEqual(findDuplicateRegistrations(registrations), []);
});

test("test_noCheckedInHookScriptIsRegisteredTwiceForOneOverlappingEventScope", () => {
    // Plain-English step: load this repo's own checked-in project settings and plugin hooks, then assert no self-inflicted duplicate.
    // Scope: this covers only .claude/settings.json and hooks/hooks.json as checked into this repository — not
    // user, local, managed, other-plugin, or in-memory registrations a live Claude Code session may also apply.
    const registrations = FILES
        .filter(file => existsSync(join(ROOT, file)))
        .flatMap(file => {
            const config = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
            return Object.entries(config.hooks ?? {}).flatMap(([event, groups]) =>
                (groups as Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }>).flatMap(group =>
                    (group.hooks ?? [])
                        .filter(hook => hook.type === "command")
                        .map(hook => ({ event, matcher: group.matcher, command: hook.command })),
                ),
            );
        });
    assert.deepEqual(findDuplicateRegistrations(registrations), []);
});
```

All sixteen fail today: `scripts/hookRegistrationAudit.ts` does not exist.

### Step 2 — green: write the module

Create `scripts/hookRegistrationAudit.ts`:

```ts
// Detects two hook registrations that would both fire for the same tool call: same script identity, same event, overlapping matcher.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export type HookRegistration = { event: string; matcher: string | undefined; command: string };

// This repo's hooks.json only ever spells a hook as "node [--flag]* <quoted-or-bare script path> [args...]";
// a command outside that shape throws instead of being silently mis-normalized by a guessed tokenizer.
const COMMAND_SHAPE = /^node(?:\s+--[\w-]+)*\s+(?:"([^"]+)"|'([^']+)'|(\S+))/;

// ${CLAUDE_PLUGIN_ROOT} and this checkout's own resolved absolute path name the same location; both
// collapse to the same "<root>" marker so a script's identity survives whichever form the command uses.
export function normalizeCommandIdentity(command: string): string {
    const match = command.match(COMMAND_SHAPE);
    if (match === null) {
        throw new Error(`hookRegistrationAudit: command does not match the recognized node-script shape: ${command}`);
    }
    const scriptPath = match[1] ?? match[2] ?? match[3] ?? "";
    return scriptPath.replace("${CLAUDE_PLUGIN_ROOT}", "<root>").replace(PROJECT_ROOT, "<root>");
}

// A matcher made only of word characters and hyphens joined by "|" is a plain tool-name alternation.
// Anything else (grouping, anchors, wildcards) is a real regex this function does not try to intersect.
const LITERAL_ALTERNATION = /^[\w-]+(\|[\w-]+)*$/;

function literalToolNames(matcher: string): Set<string> | null {
    if (!LITERAL_ALTERNATION.test(matcher)) return null;
    return new Set(matcher.split("|"));
}

// undefined means "every tool", so it overlaps anything. A non-literal matcher on either side cannot be
// proven disjoint here, so it conservatively overlaps too — a missed duplicate is worse than a false one.
export function matchersOverlap(a: string | undefined, b: string | undefined): boolean {
    if (a === undefined) return true;
    if (b === undefined) return true;
    const toolsA = literalToolNames(a);
    const toolsB = literalToolNames(b);
    if (toolsA === null) return true;
    if (toolsB === null) return true;
    for (const tool of toolsA) {
        if (toolsB.has(tool)) return true;
    }
    return false;
}

export function findDuplicateRegistrations(registrations: HookRegistration[]): string[] {
    const withIdentity = registrations.map(registration => ({ ...registration, identity: normalizeCommandIdentity(registration.command) }));
    const duplicates: string[] = [];
    for (let i = 0; i < withIdentity.length; i++) {
        for (let j = i + 1; j < withIdentity.length; j++) {
            const a = withIdentity[i]!;
            const b = withIdentity[j]!;
            if (a.identity !== b.identity) continue;
            if (a.event !== b.event) continue;
            if (!matchersOverlap(a.matcher, b.matcher)) continue;
            duplicates.push(`${a.identity} is registered twice on ${a.event} (matchers ${JSON.stringify(a.matcher)} and ${JSON.stringify(b.matcher)} overlap)`);
        }
    }
    return duplicates;
}
```

Each nested `if` in `normalizeCommandIdentity`, `matchersOverlap`, and `findDuplicateRegistrations` tests exactly one condition, matching `~/.claude/guides/single-condition-branching.md`. No `try`/`catch`: an unrecognized command shape throws and stops the test run, which is the point — a static gate that silently swallowed an unparseable command would be worse than one that stops and says so.

## Verification

```sh
set -o pipefail
npm test 2>&1 \
| tee /tmp/tasktools-npm-test.log \
| awk '
    /^✖ / { print }
    /^ℹ fail / { saw_summary = 1; failures = $3 + 0 }
    END {
        if (saw_summary && failures == 0) {
        print "all passing"
        } else if (!saw_summary) {
        print "✖ test runner stopped before producing a summary; see /tmp/tasktools-npm-test.log"
        exit 2
        }
    }
    '
```

If it does not report "all passing", run `Bash(npm test 2>&1 | tail -50)` and fix the codebase until it does. Do not re-run `npm test` again once it reports "all passing".
