import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const payload = JSON.parse(readFileSync(0, "utf8")) as { prompt?: string; cwd?: string };

const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
if (prompt !== "/task-tests" && !prompt.startsWith("/task-tests ")) {
    process.exit(0);
}

const LOG_PATH = "/tmp/tasktools-npm-test.log";

// INITIAL_PASS from ~/.claude/CLAUDE.md "Full Suite Testing", verbatim.
const INITIAL_PASS = `set -o pipefail
npm test 2>&1 \\
| tee ${LOG_PATH} \\
| awk '
    /^✖ / { print }
    /^ℹ fail / { saw_summary = 1; failures = $3 + 0 }
    END {
        if (saw_summary && failures == 0) {
        print "all passing"
        } else if (!saw_summary) {
        print "✖ test runner stopped before producing a summary; see ${LOG_PATH}"
        exit 2
        }
    }
    '`;

const run = spawnSync("bash", ["-c", INITIAL_PASS], { cwd: payload.cwd ?? process.cwd(), encoding: "utf8" });
const output = `${run.stdout}${run.stderr}`.trim();

function emit(additionalContext: string): never {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }));
    process.exit(0);
}

if (output === "all passing") {
    emit("all tests passed");
}

// The node test reporter ends with "✖ failing tests:" then pairs of "test at FILE:LINE:COL" / "✖ NAME (ms)".
const log = readFileSync(LOG_PATH, "utf8");
const summary = log.slice(log.indexOf("✖ failing tests:"));
const failingTests: string[] = [];
const lines = summary.split("\n");
for (let i = 0; i < lines.length; i++) {
    const location = lines[i].match(/^test at (.+):\d+:\d+$/);
    if (!location) continue;
    const name = lines[i + 1]?.replace(/^✖ /, "").replace(/ \(\d+(\.\d+)?ms\)$/, "");
    failingTests.push(`- ${location[1]} — ${name}`);
}

emit([
    "Tests failed. Spawn ONE subagent (general-purpose) to fix them. Give it these instructions verbatim:",
    "  1. First invoke `/ponytail ultra`.",
    "  2. Fix each failing test below. Fix the code under test, not the test, unless the test asserts behavior the design no longer has — then stop and report which one.",
    "  3. Re-run each fixed test file alone with `node --test <file>` and report pass/fail counts. Do not stage or commit.",
    "",
    "Failing tests (file — name):",
    ...(failingTests.length > 0 ? failingTests : [output]),
].join("\n"));
