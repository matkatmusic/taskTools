// The one place a suite runs and its failures are parsed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Per process: a suite that runs this hook under test would otherwise truncate the outer run's log.
export const LOG_PATH = `/tmp/tasktools-npm-test-${process.pid}.log`;

// INITIAL_PASS from ~/.claude/CLAUDE.md "Full Suite Testing", verbatim.
export const INITIAL_PASS = `set -o pipefail
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

export type FailingTest = { file: string; name: string };

export function runSuite(cwd: string): { allPassing: boolean; output: string; log: string } {
    // npm walks up to a parent package.json; from a fixture inside this repo that reruns this whole suite, forever.
    if (!existsSync(join(cwd, "package.json"))) throw new Error(`task-tests: no package.json in ${cwd}`);
    // ponytail: strip NODE_TEST_CONTEXT and RUN_STEP_LOG so the child suite inherits neither the parent test context nor the live run log
    const { NODE_TEST_CONTEXT: _parentTestContext, RUN_STEP_LOG: _parentRunStepLog, ...env } = process.env;
    const run = spawnSync("bash", ["-c", INITIAL_PASS], { cwd, encoding: "utf8", env });
    const output = `${run.stdout}${run.stderr}`.trim();
    const log = output === "all passing" ? "" : readFileSync(LOG_PATH, "utf8");
    return { allPassing: output === "all passing", output, log };
}

// The node reporter ends with "✖ failing tests:" then pairs of "test at FILE:LINE:COL" / "✖ NAME (ms)".
export function parseFailingTests(log: string): FailingTest[] {
    const summary = log.slice(log.indexOf("✖ failing tests:"));
    const failing: FailingTest[] = [];
    const lines = summary.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const location = lines[i].match(/^test at (.+):\d+:\d+$/);
        if (!location) continue;
        const name = lines[i + 1]?.replace(/^✖ /, "").replace(/ \(\d+(\.\d+)?ms\)$/, "");
        failing.push({ file: location[1], name });
    }
    return failing;
}

export const knownFailingTestsPath = (projectRoot: string) => join(projectRoot, ".taskTools", "knownFailingTests.json");

export function readKnownFailingTests(projectRoot: string): FailingTest[] {
    const path = knownFailingTestsPath(projectRoot);
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf8"));
}

export function writeKnownFailingTests(projectRoot: string, failing: FailingTest[]): void {
    mkdirSync(join(projectRoot, ".taskTools"), { recursive: true });
    writeFileSync(knownFailingTestsPath(projectRoot), `${JSON.stringify(failing, null, 2)}\n`);
}

// A failure is new when no known entry has the same file and name.
export function newFailingTests(failing: FailingTest[], known: FailingTest[]): FailingTest[] {
    return failing.filter((test) => !known.some((k) => k.file === test.file && k.name === test.name));
}

// No "all passing" and no parsed failure means the suite crashed; that is red, never a vacuous pass.
export function judgeSuite(allPassing: boolean, failing: FailingTest[], newFailures: FailingTest[]): boolean {
    return allPassing || (failing.length > 0 && newFailures.length === 0);
}
