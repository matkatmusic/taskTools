// Behavioral checks for scripts/tackle-tasks/AgentPromptEmitter.ts. Run: node --test tests/tackle-tasks/AgentPromptEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    amendTestsPrompt,
    codexReviewInstructions,
    fixConflictsPrompt,
    fixSuitePrompt,
    fixTestsPrompt,
    implementPrompt,
    loadPreparedTask,
    planPrompt,
    reviewPlanPrompt,
    reviewTestsPrompt,
    type PreparedTask,
} from "../../scripts/tackle-tasks/AgentPromptEmitter.ts";
import { buildOwnedOccurrencePaths, type Occurrence } from "../../scripts/tackle-tasks/occurrences.ts";

const cliPath = fileURLToPath(new URL("../../scripts/tackle-tasks/AgentPromptEmitter.ts", import.meta.url));

// A hand-built PreparedTask for pure structural tests that never touch a real worktree.
const fakeTask: PreparedTask = {
    number: 99,
    briefFile: "/tmp/fake-worktree/plans/brief-99.md",
    planFile: "/tmp/fake-worktree/plans/plan.json",
    reviewFile: "/tmp/fake-worktree/plans/codex-review.json",
    testReviewFile: "/tmp/fake-worktree/plans/test-review.json",
    notesFile: "/tmp/fake-worktree/plans/task-99-implementation-notes.md",
    files: ["src/thing.ts"],
    tests: "node --test tests/thing.test.ts",
    repoRoot: "/tmp/fake-worktree",
    taskStateRoot: "/tmp/fake-worktree",
};

// Sets up a project root with a task record, and a brief file already written into the
// worktree (loadPreparedTask is read-only now — it never creates the brief itself).
function makeFixture(taskNumber = 42): { projectRoot: string; worktree: string; task: PreparedTask } {
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-prompt-emitter-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([
        { taskNumber, title: "sample task", files: ["src/thing.ts"], tests: "node --test tests/thing.test.ts" },
    ]));
    writeFileSync(join(projectRoot, "completedTasks.json"), "[]");
    const worktree = projectRoot;
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, "plans", `brief-${taskNumber}.md`), `# fixture sentinel brief for task ${taskNumber}\n`);
    const task = loadPreparedTask(taskNumber, worktree, projectRoot);
    return { projectRoot, worktree, task };
}

// Every eight-role prompt, built from one shared fixture, for tests that check a property over all of them.
function allRolePrompts(task: PreparedTask): Record<string, string> {
    return {
        plan: planPrompt(task),
        "review-plan": reviewPlanPrompt(task),
        implement: implementPrompt(task, "", "npx tsc --noEmit", 3),
        "fix-conflicts": fixConflictsPrompt("/repo", ["src/thing.ts"]),
        "fix-suite": fixSuitePrompt("/repo", "", "1 failing", []),
        "fix-tests": fixTestsPrompt("/repo", "", "1 failing", [], task.number),
        "review-tests": reviewTestsPrompt(task),
        "amend-tests": amendTestsPrompt(task, "notes", ["tests/created.test.ts"], ["tests/foreign.test.ts"]),
    };
}

test("test_agentPromptEmitter_exitsNonZeroOnAnUnknownRole", () => {
    // Setup: a fixture with a valid task, but a role name no handler recognizes.
    const { projectRoot, worktree } = makeFixture();
    const payload = JSON.stringify({ worktree, projectRoot, sourceBranch: "main", runId: "run-1" });

    // Test action: run the CLI directly with role "not-a-real-role".
    const result = spawnSync("node", [cliPath, "42", "not-a-real-role"], { input: payload, encoding: "utf8" });

    // Verification: the process exits non-zero rather than printing a prompt.
    assert.notEqual(result.status, 0);
});

test("test_agentPromptEmitter_emitsTheSameCodexFallbackChainForBothReviewRoles", () => {
    // Setup: two different review questions routed through the one shared helper.
    const planReview = codexReviewInstructions("review the plan", "the plan", 1);
    const testsReview = codexReviewInstructions("review the tests", "the tests", 1);

    // Verification: the fallback commands and their surrounding rules are identical in shape,
    // independent of the embedded question text.
    for (const chain of [planReview, testsReview]) {
        assert.match(chain, /codex exec -s read-only/);
        assert.match(chain, /claude -p .* --tools "Read" --model fable --effort medium/);
        assert.match(chain, /claude -p .* --tools "Read" --model claude-opus-4-8 --effort high/);
        assert.match(chain, /Never report a fallback review as codex\./);
    }
});

test("test_fixSuitePrompt_forbidsEditingTests", () => {
    const prompt = fixSuitePrompt("/repo", "", "1 failing", []);
    assert.match(prompt, /never the test itself/);
    assert.match(prompt, /forbidden.*to edit a test file at all/s);
});

test("test_fixTestsPrompt_forbidsEditingTests", () => {
    const prompt = fixTestsPrompt("/repo", "", "1 failing", [], 42);
    assert.match(prompt, /never the test itself/);
    assert.match(prompt, /forbidden.*to edit a test file at all/s);
});

test("test_noPromptContainsAGitCommand", () => {
    // Setup: every role's prompt, from a single fixture.
    const { task } = makeFixture(43);
    const prompts = allRolePrompts(task);

    // One regex catches every actual git-invocation shape v1_1 used to run: `git -C`, `git add`,
    // `git commit`, etc. Rule 1 says the commit box owns committing, so none may survive here.
    // A prose mention naming a git subcommand only to forbid running it (kept verbatim per the
    // plan's mapping table, e.g. "do not run `git rebase --continue`") never matches this shape.
    const gitCommandPattern = /\bgit\s+(-C\b|add\b|commit\b|push\b|checkout\b|reset\b|merge\b|rm\b)/;

    for (const [role, prompt] of Object.entries(prompts)) {
        assert.equal(gitCommandPattern.test(prompt), false, `role "${role}" contains a git command`);
    }
});

test("test_amendTestsPrompt_distinguishesCreatedTestsFromModifiedForeignOnes", () => {
    const { task } = makeFixture(44);
    const prompt = amendTestsPrompt(task, "fix it", ["tests/created.test.ts"], ["tests/foreign.test.ts"]);

    // Created tests are freely editable; the foreign one only under the broken-or-empty exception.
    assert.match(prompt, /may freely edit them/);
    assert.match(prompt, /CREATED_TEST_FILES \(freely editable\) =\n {2}- tests\/created\.test\.ts/);
    assert.match(prompt, /broken or asserts nothing applies to every one of these/);
    assert.match(prompt, /TEST_FILES \(pre-existing, broken-or-empty exception only\) =\n {2}- tests\/foreign\.test\.ts/);
});

test("test_planPrompt_includesTheScrapNotesWhenAPreambleIsGiven", () => {
    const { task } = makeFixture(45);
    const preamble = "Codex scrapped the previous plan because step-2 was vague.\n\n";

    const prompt = planPrompt(task, preamble);

    assert.match(prompt, /Codex scrapped the previous plan because step-2 was vague\./);
});

test("test_reviewTestsPrompt_forbidsRunningTheTests", () => {
    const { task } = makeFixture(46);
    const prompt = reviewTestsPrompt(task);
    assert.match(prompt, /never run the tests/i);
});

for (const [role, buildPrompt] of Object.entries({
    plan: (task: PreparedTask) => planPrompt(task),
    "review-plan": (task: PreparedTask) => reviewPlanPrompt(task),
    implement: (task: PreparedTask) => implementPrompt(task, "a note", "npx tsc --noEmit", 3),
    "fix-conflicts": () => fixConflictsPrompt("/repo", ["src/thing.ts"]),
    "fix-suite": () => fixSuitePrompt("/repo", "root-layer", "1 failing", ["vendor"]),
    "fix-tests": (task: PreparedTask) => fixTestsPrompt("/repo", "root-layer", "1 failing", ["vendor"], task.number),
    "review-tests": (task: PreparedTask) => reviewTestsPrompt(task),
    "amend-tests": (task: PreparedTask) => amendTestsPrompt(task, "notes", ["tests/created.test.ts"], ["tests/foreign.test.ts"]),
})) {
    test(`test_${role.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Prompt_leavesNoUnresolvedInterpolation`, () => {
        const { task } = makeFixture();
        const prompt = buildPrompt(task);
        assert.equal(prompt.includes("${"), false);
        assert.equal(prompt.includes("$ARGUMENTS"), false);
    });
}

// ---------------------------------------------------------------------------
// Finding 6 — loadPreparedTask must be read-only: it derives/validates the brief path
// but never writes it, and fails explicitly when the brief is missing.
// ---------------------------------------------------------------------------

test("test_loadPreparedTask_doesNotRewriteTheBriefFile", () => {
    // Setup: a fixture whose brief file holds sentinel content that renderTaskBrief would
    // never produce (it does not know about this exact sentence).
    const { worktree, task } = makeFixture(50);
    const before = readFileSync(task.briefFile, "utf8");

    // Test action: load the prepared task again — every role does this on the read path.
    loadPreparedTask(50, worktree, task.taskStateRoot);

    // Verification: the brief bytes are untouched. The old code called writeTaskBrief() here,
    // which regenerates the brief from tasks.json and would have overwritten this sentinel.
    const after = readFileSync(task.briefFile, "utf8");
    assert.equal(after, before);
});

test("test_agentPromptEmitter_failsExplicitlyWhenTheBriefIsMissing", () => {
    // Setup: a project/worktree with a valid task but NO brief file written anywhere.
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-prompt-emitter-nobrief-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([
        { taskNumber: 51, title: "sample", files: ["src/thing.ts"], tests: "skip" },
    ]));
    writeFileSync(join(projectRoot, "completedTasks.json"), "[]");
    const payload = JSON.stringify({ worktree: projectRoot, projectRoot, sourceBranch: "main", runId: "run-1" });

    // Test action: run the CLI for a role that loads the prepared task.
    const result = spawnSync("node", [cliPath, "51", "plan"], { input: payload, encoding: "utf8" });

    // Verification: it fails loudly instead of silently writing the brief and succeeding. The
    // old code called writeTaskBrief() here, would have exited 0, and left a brief on disk.
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(projectRoot, "plans", "brief-51.md")), false);
});

test("test_agentPromptEmitter_mutatesNothingInTheWorktreeForAnyRole", () => {
    // Setup: a fixture with a sentinel brief, snapshotted byte-for-byte before any role runs.
    const { projectRoot, worktree } = makeFixture(52);

    function snapshotTree(root: string): Record<string, string> {
        const out: Record<string, string> = {};
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else out[full] = readFileSync(full, "utf8");
            }
        };
        walk(root);
        return out;
    }

    const before = snapshotTree(worktree);

    const roleInvocations: Array<[string, object]> = [
        ["plan", {}],
        ["review-plan", {}],
        ["implement", {}],
        ["review-tests", {}],
        ["amend-tests", { notes: "n", createdTestFiles: [], testFiles: [] }],
        ["fix-conflicts", { checkoutPath: worktree, conflictedFilePaths: [] }],
        ["fix-suite", { checkoutPath: worktree, occurrenceId: "", testOutput: "x", forbiddenPaths: [] }],
        ["fix-tests", { checkoutPath: worktree, occurrenceId: "", testOutput: "x", forbiddenPaths: [] }],
    ];

    // Test action: invoke every CLI role classified read-only against this one worktree.
    for (const [role, extra] of roleInvocations) {
        const payload = JSON.stringify({ worktree, projectRoot, sourceBranch: "main", runId: "run-1", ...extra });
        const result = spawnSync("node", [cliPath, "52", role], { input: payload, encoding: "utf8" });
        assert.equal(result.status, 0, `role "${role}" exited nonzero: ${result.stderr}`);
    }

    // Verification: no file bytes or paths changed. The old code would have rewritten
    // plans/brief-52.md on every role that plans/reviews/implements/amends.
    const after = snapshotTree(worktree);
    assert.deepEqual(after, before);
});

// ---------------------------------------------------------------------------
// Finding 7 — every role's return instruction is exactly the Phase 9 table shape; the old
// v1.1 fields (task, status, planFile, question, missingFiles, summary) are gone.
// ---------------------------------------------------------------------------

test("test_planPrompt_returnsExactlyPlanWritten", () => {
    // Old code returned {task, status, planFile, question, missingFiles} and never planWritten.
    const prompt = planPrompt(fakeTask);
    assert.match(prompt, /Return \{planWritten\}\.\n/);
    assert.equal(/"status"/.test(prompt), false);
    assert.equal(/missingFiles/.test(prompt), false);
    assert.equal(/\{task:/i.test(prompt), false);
});

test("test_reviewPlanPrompt_returnsExactlyReviewWrittenAndReviewer", () => {
    // Old code returned {task, reviewWritten, reviewer}; task must be gone.
    const prompt = reviewPlanPrompt(fakeTask);
    assert.match(prompt, /Return \{reviewWritten: true, reviewer\}\.\n?$/);
    assert.equal(/\{task:/i.test(prompt), false);
});

test("test_implementPrompt_returnContractDropsTheOldTaskAndSummaryFields", () => {
    // Old code returned {task, implemented, implementationNotesFile, remaining[, summary]}.
    const prompt = implementPrompt(fakeTask, "", "npx tsc --noEmit", 3);
    assert.equal(/\{task:/i.test(prompt), false);
    assert.equal(/summary/i.test(prompt), false);
    assert.match(prompt, /\{implemented: (true|false), implementationNotesFile: notesFile, remaining:/);
});

test("test_reviewTestsPrompt_returnsExactlyFlaggedAndReviewer", () => {
    // Old code returned {task, flagged, reviewer}; task must be gone.
    const prompt = reviewTestsPrompt(fakeTask);
    assert.match(prompt, /Return \{flagged, reviewer\}\.\n?$/);
    assert.equal(/\{task:/i.test(prompt), false);
});

test("test_amendTestsPrompt_returnsExactlyAmended", () => {
    // Old code returned {task, amended}; task must be gone.
    const prompt = amendTestsPrompt(fakeTask, "n", [], []);
    assert.match(prompt, /\{amended: true\}/);
    assert.match(prompt, /\{amended: false\}/);
    assert.equal(/\{task:/i.test(prompt), false);
});

test("test_fixConflictsPrompt_returnsExactlyResolvedAndUnresolvedPaths", () => {
    const prompt = fixConflictsPrompt("/repo", ["a"]);
    assert.match(prompt, /\{resolved: true, unresolvedPaths: \[\]\}/);
    assert.match(prompt, /\{resolved: false, unresolvedPaths:/);
});

test("test_fixSuitePrompt_returnsExactlyFixed", () => {
    const prompt = fixSuitePrompt("/repo", "", "x", []);
    assert.match(prompt, /\{fixed: true\}/);
    assert.match(prompt, /\{fixed: false\}/);
});

test("test_fixTestsPrompt_returnsExactlyFixed", () => {
    const prompt = fixTestsPrompt("/repo", "", "x", [], 1);
    assert.match(prompt, /\{fixed: true\}/);
    assert.match(prompt, /\{fixed: false\}/);
});

// ---------------------------------------------------------------------------
// Finding 8 — fix-suite/fix-tests may only edit the occurrence-appropriate owned source
// paths; the whole checkout is never the edit boundary.
// ---------------------------------------------------------------------------

test("test_fixSuitePrompt_namesTheOwnedPathAsTheCompleteEditAllowlist", () => {
    // Old code named no specific path at all — it granted "the source code inside checkoutPath
    // that the failing test covers", so this exact listing would not exist against old code.
    const prompt = fixSuitePrompt("/repo", "", "1 failing", [], ["src/owned.ts"]);
    assert.match(prompt, /OWNED_SOURCE_PATHS \(the complete edit allowlist, relative to CHECKOUT_PATH\) =\n {2}- src\/owned\.ts/);
});

test("test_fixSuitePrompt_doesNotGrantTheWholeCheckoutAsAnEditBoundary", () => {
    // Old wording ("EDIT the source code inside ${checkoutPath} that the failing test covers")
    // implicitly authorized any file under the checkout; that phrase must be gone.
    const prompt = fixSuitePrompt("/repo", "", "1 failing", [], ["src/owned.ts"]);
    assert.equal(/EDIT the source code inside/.test(prompt), false);
});

test("test_fixTestsPrompt_namesTheOwnedPathAsTheCompleteEditAllowlist", () => {
    const prompt = fixTestsPrompt("/repo", "", "1 failing", [], 42, ["src/owned.ts"]);
    assert.match(prompt, /OWNED_SOURCE_PATHS \(the complete edit allowlist, relative to CHECKOUT_PATH\) =\n {2}- src\/owned\.ts/);
});

test("test_fixTestsPrompt_doesNotGrantTheWholeCheckoutAsAnEditBoundary", () => {
    const prompt = fixTestsPrompt("/repo", "", "1 failing", [], 42, ["src/owned.ts"]);
    assert.equal(/EDIT the source code inside/.test(prompt), false);
});

test("test_fixSuitePrompt_acceptsOccurrenceAppropriateOwnedPathsFromBuildOwnedOccurrencePaths", () => {
    // Integration with occurrences.ts's real owned-path derivation, per the finding's guidance
    // to pass occurrence-appropriate owned source paths in.
    const occurrences: Occurrence[] = [
        { occurrenceId: "", checkoutPath: "/repo", depth: 0, baseRef: "main" },
        { occurrenceId: "vendor/lib", checkoutPath: "/repo/vendor/lib", depth: 1, baseRef: "main" },
    ];
    const owned = buildOwnedOccurrencePaths(["src/thing.ts", "vendor/lib/src/other.ts"], occurrences);

    // Root-layer prompt: only the root-owned path is in scope for this layer's fix.
    const rootOwned = owned.filter((p) => !p.startsWith("vendor/lib::"));
    const prompt = fixSuitePrompt("/repo", "", "1 failing", ["vendor/lib"], rootOwned);
    assert.match(prompt, /- src\/thing\.ts/);
    assert.equal(prompt.includes("vendor/lib::"), false);
});

// ---------------------------------------------------------------------------
// Finding 9 — every builder puts static instructions and the return contract first, and
// appends all runtime/bulk data after a final "---- DATA ----" marker.
// ---------------------------------------------------------------------------

test("test_planPrompt_putsThePreambleAfterTheDataMarker", () => {
    const sentinel = "SENTINEL_PLAN_PREAMBLE_9f3q";
    const prompt = planPrompt(fakeTask, `${sentinel}\n\n`);
    const markerIndex = prompt.indexOf("---- DATA ----");
    assert.notEqual(markerIndex, -1);
    assert.ok(prompt.indexOf(sentinel) > markerIndex);
});

test("test_reviewPlanPrompt_putsOwnedFilesAfterTheNestedDataMarker", () => {
    const sentinel = "SENTINEL_REVIEW_PLAN_OWNED_8b1z";
    const task: PreparedTask = { ...fakeTask, files: [sentinel] };
    const prompt = reviewPlanPrompt(task);
    const markerIndex = prompt.indexOf("---- DATA ----");
    assert.notEqual(markerIndex, -1);
    assert.ok(prompt.indexOf(sentinel) > markerIndex);
});

test("test_reviewTestsPrompt_putsBriefFileAfterTheNestedDataMarker", () => {
    const sentinel = "/tmp/SENTINEL_REVIEW_TESTS_BRIEF_2ke9/plans/brief-99.md";
    const task: PreparedTask = { ...fakeTask, briefFile: sentinel };
    const prompt = reviewTestsPrompt(task);
    const markerIndex = prompt.indexOf("---- DATA ----");
    assert.notEqual(markerIndex, -1);
    assert.ok(prompt.indexOf(sentinel) > markerIndex);
});

test("test_implementPrompt_putsTheNoteAfterTheDataMarker", () => {
    const sentinel = "SENTINEL_IMPLEMENT_NOTE_7cq2";
    const prompt = implementPrompt(fakeTask, sentinel, "npx tsc --noEmit", 3);
    const markerIndex = prompt.indexOf("---- DATA ----");
    assert.notEqual(markerIndex, -1);
    assert.ok(prompt.indexOf(sentinel) > markerIndex);
});

test("test_fixConflictsPrompt_putsTheConflictedPathsAfterTheDataMarker", () => {
    const sentinel = "src/SENTINEL_CONFLICT_PATH_4dw1.ts";
    const prompt = fixConflictsPrompt("/repo", [sentinel]);
    const markerIndex = prompt.indexOf("---- DATA ----");
    assert.notEqual(markerIndex, -1);
    assert.ok(prompt.indexOf(sentinel) > markerIndex);
});

test("test_fixSuitePrompt_putsTheFailureOutputAfterTheDataMarker", () => {
    const sentinel = "SENTINEL_FIX_SUITE_FAILURE_OUTPUT_5xr8";
    const prompt = fixSuitePrompt("/repo", "", sentinel, []);
    const markerIndex = prompt.indexOf("---- DATA ----");
    assert.notEqual(markerIndex, -1);
    assert.ok(prompt.indexOf(sentinel) > markerIndex);
});

test("test_fixTestsPrompt_putsTheFailureOutputAfterTheDataMarker", () => {
    const sentinel = "SENTINEL_FIX_TESTS_FAILURE_OUTPUT_6yt3";
    const prompt = fixTestsPrompt("/repo", "", sentinel, [], 1);
    const markerIndex = prompt.indexOf("---- DATA ----");
    assert.notEqual(markerIndex, -1);
    assert.ok(prompt.indexOf(sentinel) > markerIndex);
});

test("test_amendTestsPrompt_putsTheReviewerNotesAfterTheDataMarker", () => {
    const sentinel = "SENTINEL_AMEND_NOTES_1qz7";
    const prompt = amendTestsPrompt(fakeTask, sentinel, [], []);
    const markerIndex = prompt.indexOf("---- DATA ----");
    assert.notEqual(markerIndex, -1);
    assert.ok(prompt.indexOf(sentinel) > markerIndex);
});
