import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const payload = JSON.parse(readFileSync(0, "utf8")) as { prompt?: string; cwd?: string };

const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
if (prompt !== "/task-tests" && !prompt.startsWith("/task-tests ")) {
    process.exit(0);
}

// INITIAL_PASS from ~/.claude/CLAUDE.md "Full Suite Testing", verbatim.
const INITIAL_PASS = `set -o pipefail
npm test 2>&1 \\
| tee /tmp/tasktools-npm-test.log \\
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
    '`;

const run = spawnSync("bash", ["-c", INITIAL_PASS], { cwd: payload.cwd ?? process.cwd(), encoding: "utf8" });
const output = `${run.stdout}${run.stderr}`.trim();

if (output === "all passing") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "all tests passed" } }));
    process.exit(0);
}

process.stdout.write(JSON.stringify({ decision: "block", reason: output }));
