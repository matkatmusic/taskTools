import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { skillBody, type RunContext } from "../scripts/tackle-tasks/PlannerBodyEmitter.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const ctx: RunContext = { runId: "test-run", projectRoot, sourceBranch: "master" };

// ponytail: only the read-only exits are covered. The paths past "claim the task" create worktrees and write tasks.json, so they need a fixture repo, not this one.
// planPrompt's own tests moved to tests/planPrompt.test.ts, alongside its new home in scripts/tackle-tasks/planPrompt.ts.
test("an unknown task number stops with invalid-number and writes nothing", () => {
    const body = skillBody(999999, false, ctx);
    assert.match(body, /Do nothing except report/);
    assert.match(body, /Task 999999: invalid-number/);
});
