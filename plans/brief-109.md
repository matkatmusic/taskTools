# Task 109: Format task-stats output as markdown sections — ANSI is stripped on every path to the user

## Goal

**This task is considered done when all of these are true:**

formatTaskStats emits basic markdown: headed sections plus one table for contended files.
The markdown renders correctly on the /task-stats skill path, not as literal characters.
The layout stays plain enough to hand-tweak later; no clever or generated styling.
Every number and label the current plain formatter emits still appears in the new output.
The output contains no ESC byte (0x1b) anywhere.
A fixture with zero contended files omits that section instead of emitting an empty table.

## User request

make the output of task-stats pretty with some color coding if possible.  TODO: decide on color scheme/sections.

**The TODO in the request is resolved: use markdown, not ANSI. This was settled experimentally, not by argument.**

Probe 1 — ANSI through the skill path. A line `\x1b[32mGREEN-PROBE\x1b[0m` was added to the brief and `/task-stats` invoked. `node scripts/taskStatsBrief.ts | cat -v` confirmed the raw bytes leave the script intact (`^[[32mGREEN-PROBE^[[0m`), but what reached the skill body was `[32mGREEN-PROBE[0m` — Claude Code strips the ESC control byte when injecting `!`-command output and leaves the rest as literal garbage. Note the encoding is NOT the cause: `encoding: "utf8"` at taskStatsBrief.ts:7 only makes execFileSync return a string, and ESC survives that fine.

Probe 2 — ANSI in the assistant's own message. Same result: the escape renders as literal text, never as color. So there is no path from this script to the user's screen on which ANSI survives, and `node:util styleText` would buy nothing here.

Probe 3 — markdown through the same path. A heading, `**bold**`, `` `code` ``, `*italic*` and a two-column table were injected the same way; all survived the injection byte-for-byte and rendered correctly in the terminal. Markdown is the mechanism.

**Where the work goes.** `formatTaskStats` at scripts/taskStats.ts:84-102 already assembles a `string[]` and joins it — it just emits flat prose lines today. Reshape those into headed sections and render `contendedFiles` (:97-100) as a markdown table instead of two-space-indented lines. `computeTaskStats` and the `TaskStats` type need no change; this is presentation only.

**Proposed sections**, derived from the existing lines: Backlog (open/unblocked/blocked from :86, files coverage from :87), Velocity (completed + hashes from :88, closure counts from :89, busiest day from :91), Parallelism (:92-96), Contended files (:97-100, as a table).

**Collision warning.** Task 108 also edits `formatTaskStats` to add blocker-chain lines and a `fastest unblocking sequence:` line. Both tasks rewrite the same function. Doing 108 first means styling the finished content set once; doing 109 first means 108 must match the new section layout. Deliberately left unblocked so either can start, but whoever goes second must expect a conflict here.

## Files

@scripts/taskStats.ts
@tests/taskStats.test.ts