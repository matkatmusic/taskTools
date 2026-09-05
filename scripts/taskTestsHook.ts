// Runs /task-tests as a typed prompt or a Skill call, and records its failures as the known baseline.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runSuite, parseFailingTests, writeKnownFailingTests } from "./taskTestsRunner.ts";

let payload: { hook_event_name?: unknown; prompt?: unknown; cwd?: unknown; tool_input?: Record<string, unknown> };
try {
    payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
    process.exit(0);
}

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

if (args !== "" && !args.startsWith("/")) {
    throw new Error(`task-tests: path must be absolute: ${args}`);
}
const cwd = args !== "" ? args : (typeof payload.cwd === "string" ? payload.cwd : process.cwd());
const projectRoot = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function emit(additionalContext: string): never {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext } }));
    process.exit(0);
}

const suite = await runSuite(cwd);
const failing = suite.allPassing ? [] : parseFailingTests(suite.log);
writeKnownFailingTests(projectRoot, failing);

if (suite.allPassing) {
    emit(`all tests passed; recorded 0 known failing tests in ${projectRoot}`);
}

emit([
    "Tests failed. Spawn ONE subagent (general-purpose) to fix them. Give it these instructions verbatim:",
    "  1. First invoke `/ponytail ultra`.",
    "  2. Fix each failing test below. Fix the code under test, not the test, unless the test asserts behavior the design no longer has — then stop and report which one.",
    "  3. Re-run each fixed test file alone with `node --test <file>` and report pass/fail counts. Do not stage or commit.",
    "",
    "Failing tests (file — name):",
    ...(failing.length > 0 ? failing.map((test) => `- ${test.file} — ${test.name}`) : [suite.output]),
    "",
    `Recorded ${failing.length} known failing tests in ${projectRoot}; the tackle-tasks test gate now ignores exactly these.`,
].join("\n"));
