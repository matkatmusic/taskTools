// Behavioral checks for scripts/tackle-tasks/AgentPromptEmitter.ts. Run: node --test tests/tackle-tasks/AgentPromptEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { buildOccurrencePath, buildOwnedOccurrencePaths, type Occurrence } from "../../scripts/tackle-tasks/occurrences.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";

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
    const planReview = codexReviewInstructions("review the plan", "the plan");
    const testsReview = codexReviewInstructions("review the tests", "the tests");

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

// ---------------------------------------------------------------------------
// Phase 10 audit finding 6 — amendTestsPrompt must derive the pre-existing list from
// testFiles minus createdTestFiles (never trust the caller's subtraction), and must resolve
// every occurrence-tagged path to a real absolute path in the worktree, including inside a
// nested submodule occurrence. A real submodule and a real `git worktree add` are used
// throughout, per global rule 9 — no mock, no standalone repo standing in for a linked worktree.
// ---------------------------------------------------------------------------

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = mkdtempSync(join(tmpdir(), "agent-prompt-emitter-occ-"));
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

// The canonical source repository: a root repo with one real submodule, per global rule 9.
function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeTempRepoWithCommit("child-main");
    const rootOrigin = makeTempRepoWithCommit("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return rootOrigin;
}

let nextOccurrenceGroupId = 9001;

// A real linked worktree (root + submodule checked out via `git worktree add`), with tasks.json
// and the brief already in place so loadPreparedTask succeeds.
function makeOccurrenceFixture(): { rootOrigin: string; worktree: string; task: PreparedTask } {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const taskNumber = nextOccurrenceGroupId++;
    const worktree = createWorktreeForGroup(rootOrigin, {
        groupId: taskNumber,
        taskNumbers: [taskNumber],
        filePaths: [],
        scope: "declared",
    });
    writeFileSync(join(rootOrigin, "tasks.json"), JSON.stringify([
        { taskNumber, title: "sample task", files: [], tests: "skip" },
    ]));
    writeFileSync(join(rootOrigin, "completedTasks.json"), "[]");
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, "plans", `brief-${taskNumber}.md`), `# fixture sentinel brief for task ${taskNumber}\n`);
    const task = loadPreparedTask(taskNumber, worktree, rootOrigin);
    return { rootOrigin, worktree, task };
}

// Writes and commits a real file at relativePath inside checkoutPath, so occurrence resolution
// has something real on disk to point at (not just a string it happens to compute correctly).
function commitRealFile(checkoutPath: string, relativePath: string, contents: string): void {
    mkdirSync(join(checkoutPath, join(relativePath, "..")), { recursive: true });
    writeFileSync(join(checkoutPath, relativePath), contents);
    git(checkoutPath, "add", relativePath);
    git(checkoutPath, "commit", "-q", "-m", `add ${relativePath}`);
}

// Parses every "- taggedPath => absolutePath" edit-path line out of one DATA section of a
// rendered amend-tests prompt, so assertions test what the agent actually receives rather than
// a path recomputed independently in the test.
function parseEmittedTestFileEntries(section: string): Array<{ taggedPath: string; absolutePath: string }> {
    return section.split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => {
            const [taggedPath, absolutePath] = line.slice(2).split(" => ");
            return { taggedPath, absolutePath };
        });
}

test("test_amendTestsPrompt_theCreatedAndPreExistingListsAreDisjoint", () => {
    // Setup: testFiles (every runnable changed test) contains both the created test and a
    // separately modified pre-existing one, as runTaskTests.ts actually returns them. Both are
    // real, committed files at the worktree root, and a third real file lives in the child
    // submodule occurrence.
    const { task } = makeOccurrenceFixture();
    const created = "tests/created.test.ts";
    const modified = "tests/modified.test.ts";
    const childPath = "tests/child.test.ts";
    const childTagged = buildOccurrencePath("child", childPath);
    commitRealFile(task.repoRoot, created, "// created\n");
    commitRealFile(task.repoRoot, modified, "// modified\n");
    commitRealFile(join(task.repoRoot, "child"), childPath, "// child\n");

    const prompt = amendTestsPrompt(task, "fix it", [created], [created, modified, childTagged]);

    // Verification: the created test appears only in CREATED_TEST_FILES, never restated in
    // TEST_FILES as a pre-existing test subject to the broken-or-empty restriction.
    const data = prompt.slice(prompt.indexOf("---- DATA ----"));
    const createdSection = data.slice(data.indexOf("CREATED_TEST_FILES"), data.indexOf("TEST_FILES (pre-existing"));
    const preExistingSection = data.slice(data.indexOf("TEST_FILES (pre-existing"), data.indexOf("REVIEWER_NOTES"));
    assert.match(createdSection, /tests\/created\.test\.ts/);
    assert.doesNotMatch(preExistingSection, /- tests\/created\.test\.ts =>/);
    assert.match(preExistingSection, /tests\/modified\.test\.ts/);
    assert.match(preExistingSection, /child::tests\/child\.test\.ts/);

    // Verification: every emitted edit path, in both categories, is a real, readable file that
    // resolves inside the checkout its own tag names — never a nonexistent joined string.
    const entries = [...parseEmittedTestFileEntries(createdSection), ...parseEmittedTestFileEntries(preExistingSection)];
    assert.equal(entries.length, 3);
    for (const { taggedPath, absolutePath } of entries) {
        const expectedCheckout = taggedPath.startsWith("child::") ? join(task.repoRoot, "child") : task.repoRoot;
        assert.ok(existsSync(absolutePath), `${absolutePath} does not exist`);
        assert.equal(statSync(absolutePath).isFile(), true, `${absolutePath} is not a regular file`);
        assert.doesNotThrow(() => readFileSync(absolutePath, "utf8"), `${absolutePath} could not be read`);
        assert.equal(absolutePath.startsWith(`${expectedCheckout}/`), true, `${absolutePath} is not inside ${expectedCheckout}`);
    }
});

test("test_amendTestsPrompt_resolvesANestedOccurrenceTestFileToAnAbsolutePathInsideItsCheckout", () => {
    // Setup: a real submodule occurrence "child" and a real, committed test file inside it,
    // tagged the same way runTaskTests.ts tags a change inside that submodule.
    const { task } = makeOccurrenceFixture();
    const childPath = "tests/child.test.ts";
    const taggedPath = buildOccurrencePath("child", childPath);
    commitRealFile(join(task.repoRoot, "child"), childPath, "// child\n");

    const prompt = amendTestsPrompt(task, "fix it", [], [taggedPath]);

    // Verification: the emitted path is absolute, points at the real file inside the child
    // submodule's checkout in THIS worktree (not the raw tagged string), and is directly openable.
    const data = prompt.slice(prompt.indexOf("---- DATA ----"));
    const preExistingSection = data.slice(data.indexOf("TEST_FILES (pre-existing"), data.indexOf("REVIEWER_NOTES"));
    const [entry] = parseEmittedTestFileEntries(preExistingSection);
    const expectedCheckout = join(task.repoRoot, "child");
    assert.equal(entry.taggedPath, taggedPath);
    assert.ok(existsSync(entry.absolutePath), `${entry.absolutePath} does not exist`);
    assert.equal(statSync(entry.absolutePath).isFile(), true);
    assert.doesNotThrow(() => readFileSync(entry.absolutePath, "utf8"));
    assert.equal(entry.absolutePath.startsWith(`${expectedCheckout}/`), true);
});

test("test_amendTestsPrompt_resolvesARootOccurrenceTestFileToAnAbsolutePathAtTheWorktreeRoot", () => {
    // Setup: a plain (untagged) test path, the root occurrence's shape, as a real committed file.
    const { task } = makeOccurrenceFixture();
    const rootPath = "tests/root.test.ts";
    commitRealFile(task.repoRoot, rootPath, "// root\n");

    const prompt = amendTestsPrompt(task, "fix it", [rootPath], []);

    // Verification: resolves under the worktree root itself, not the child submodule, and points
    // at the real file.
    const data = prompt.slice(prompt.indexOf("---- DATA ----"));
    const createdSection = data.slice(data.indexOf("CREATED_TEST_FILES"), data.indexOf("TEST_FILES (pre-existing"));
    const [entry] = parseEmittedTestFileEntries(createdSection);
    assert.equal(entry.taggedPath, rootPath);
    assert.ok(existsSync(entry.absolutePath), `${entry.absolutePath} does not exist`);
    assert.equal(statSync(entry.absolutePath).isFile(), true);
    assert.doesNotThrow(() => readFileSync(entry.absolutePath, "utf8"));
    assert.equal(entry.absolutePath.startsWith(`${task.repoRoot}/`), true);
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
    // Old code returned {task, reviewWritten, reviewer}; task must be gone. The return
    // contract now sits before the final DATA section (finding 9), not at the string's end.
    const prompt = reviewPlanPrompt(fakeTask);
    assert.match(prompt, /Return \{reviewWritten: true, reviewer\}\.\n/);
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
    // Old code returned {task, flagged, reviewer}; task must be gone. The return contract
    // now sits before the final DATA section (finding 9), not at the string's end.
    const prompt = reviewTestsPrompt(fakeTask);
    assert.match(prompt, /Return \{flagged, reviewer\}\.\n/);
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

// ---------------------------------------------------------------------------
// Remediation feedback finding 9 — a final "---- DATA ----" block existed, but several
// builders still spliced runtime values (typecheck command, maxFixRounds, checkoutPath,
// subject, testReviewFile, the review/test-review output paths) into their STATIC
// instructions ahead of it. These tests give every runtime argument of every one of the
// eight roles a distinctive token, then assert (1) no token appears before the LAST
// "---- DATA ----" marker in the emitted prompt, and (2) no instruction phrase — the
// return contract or the forbidden-actions clause — appears after it. Before this fix:
// reviewPlanPrompt/reviewTestsPrompt appended "Never edit any file" / "Write the
// reviewer's JSON..." / "Return {...}" AFTER the codex block (which itself ends in a
// nested data section), implementPrompt spliced the typecheck command and maxFixRounds
// inline via `${...}` at three call sites each, fixConflictsPrompt spliced checkoutPath
// inline five times, fixCodebasePrompt spliced subject/checkoutPath inline four times,
// and amendTestsPrompt spliced testReviewFile inline once — so each of these new
// assertions would have failed against the pre-fix code.
// ---------------------------------------------------------------------------

function finalDataMarkerIndex(prompt: string): number {
    const marker = "---- DATA ----";
    const index = prompt.lastIndexOf(marker);
    assert.notEqual(index, -1, "prompt has no final DATA marker");
    return index;
}

function assertSentinelsOnlyAfterFinalData(prompt: string, sentinels: string[]) {
    const markerIndex = finalDataMarkerIndex(prompt);
    for (const sentinel of sentinels) {
        const firstIndex = prompt.indexOf(sentinel);
        assert.notEqual(firstIndex, -1, `sentinel "${sentinel}" is missing from the prompt`);
        assert.ok(firstIndex > markerIndex, `sentinel "${sentinel}" appears before the final DATA section`);
    }
}

// A nested codex review carries its own DATA section because codex receives only the question
// string; that data cannot move to the outer final section. It must still come last within the
// question, so assert it against the first marker rather than the last.
function assertNestedSentinelsOnlyAfterNestedData(prompt: string, sentinels: string[]) {
    const nestedIndex = prompt.indexOf("---- DATA ----");
    assert.notEqual(nestedIndex, -1, "prompt has no nested DATA marker");
    for (const sentinel of sentinels) {
        const firstIndex = prompt.indexOf(sentinel);
        assert.notEqual(firstIndex, -1, `nested sentinel "${sentinel}" is missing from the prompt`);
        assert.ok(firstIndex > nestedIndex, `nested sentinel "${sentinel}" appears before its DATA section`);
    }
}

function assertNoInstructionAfterFinalData(prompt: string) {
    const markerIndex = finalDataMarkerIndex(prompt);
    const after = prompt.slice(markerIndex + "---- DATA ----".length);
    assert.equal(/Return \{/.test(after), false, "a return contract appears after the final DATA section");
    assert.equal(/You are forbidden/.test(after), false, "a forbidden-actions clause appears after the final DATA section");
}

test("test_planPrompt_hasEveryRuntimeTokenOnlyAfterFinalDataAndNoInstructionAfterIt", () => {
    const task: PreparedTask = {
        ...fakeTask,
        number: 918273,
        briefFile: "/tmp/SENTINEL_BRIEF_PLAN_a1/brief.md",
        planFile: "/tmp/SENTINEL_PLANFILE_PLAN_a2/plan.json",
        files: ["SENTINEL_FILE_PLAN_a3.ts"],
        tests: "SENTINEL_TESTS_PLAN_a4",
        repoRoot: "/tmp/SENTINEL_REPOROOT_PLAN_a5",
    };
    const preamble = "SENTINEL_PREAMBLE_PLAN_a6";
    const prompt = planPrompt(task, preamble);
    assertSentinelsOnlyAfterFinalData(prompt, [
        String(task.number), task.briefFile, task.planFile, task.files[0], task.tests as string, task.repoRoot, preamble,
    ]);
    assertNoInstructionAfterFinalData(prompt);
});

test("test_reviewPlanPrompt_putsTheReviewFileOutputPathOnlyAfterTheFinalDataAndNoInstructionAfterIt", () => {
    // This is the exact defect the remediation feedback named: reviewFile used to be
    // interpolated in an outer instruction line appended AFTER the codex block.
    const task: PreparedTask = {
        ...fakeTask,
        number: 918274,
        reviewFile: "/tmp/SENTINEL_REVIEWFILE_RP_b1/codex-review.json",
        briefFile: "/tmp/SENTINEL_BRIEF_RP_b2/brief.md",
        planFile: "/tmp/SENTINEL_PLANFILE_RP_b3/plan.json",
        files: ["SENTINEL_FILE_RP_b4.ts"],
    };
    const prompt = reviewPlanPrompt(task);
    assertSentinelsOnlyAfterFinalData(prompt, [String(task.number), task.reviewFile]);
    assertNoInstructionAfterFinalData(prompt);
    assertNestedSentinelsOnlyAfterNestedData(prompt, [task.briefFile, task.planFile, task.files[0]]);
});

test("test_reviewTestsPrompt_putsTheTestReviewFileOutputPathOnlyAfterTheFinalDataAndNoInstructionAfterIt", () => {
    const task: PreparedTask = {
        ...fakeTask,
        number: 918275,
        testReviewFile: "/tmp/SENTINEL_TESTREVIEWFILE_RT_c1/test-review.json",
        briefFile: "/tmp/SENTINEL_BRIEF_RT_c2/brief.md",
        planFile: "/tmp/SENTINEL_PLANFILE_RT_c3/plan.json",
    };
    const prompt = reviewTestsPrompt(task);
    assertSentinelsOnlyAfterFinalData(prompt, [task.testReviewFile]);
    assertNoInstructionAfterFinalData(prompt);
    assertNestedSentinelsOnlyAfterNestedData(prompt, [String(task.number), task.briefFile, task.planFile]);
});

test("test_implementPrompt_hasEveryRuntimeTokenOnlyAfterFinalDataAndNoInstructionAfterIt", () => {
    // Before the fix, the typecheck command was spliced inline via `run(${rootedTypecheck})`
    // at three call sites, and maxFixRounds via `${maxFixRounds}` at three more.
    const task: PreparedTask = {
        ...fakeTask,
        number: 445566,
        planFile: "/tmp/SENTINEL_PLANFILE_IMPL_d1/plan.json",
        notesFile: "/tmp/SENTINEL_NOTESFILE_IMPL_d2/notes.md",
        files: ["SENTINEL_FILE_IMPL_d3.ts"],
        tests: "SENTINEL_TESTS_IMPL_d4",
        repoRoot: "/tmp/SENTINEL_REPOROOT_IMPL_d5",
    };
    const note = "SENTINEL_NOTE_IMPL_d6";
    const typecheckCommand = "SENTINEL_TYPECHECK_IMPL_d7";
    const maxFixRounds = 918273;
    const prompt = implementPrompt(task, note, typecheckCommand, maxFixRounds);
    assertSentinelsOnlyAfterFinalData(prompt, [
        String(task.number), task.planFile, task.notesFile, task.files[0], task.tests as string,
        task.repoRoot, note, typecheckCommand, String(maxFixRounds),
    ]);
    assertNoInstructionAfterFinalData(prompt);
});

test("test_fixConflictsPrompt_hasEveryRuntimeTokenOnlyAfterFinalDataAndNoInstructionAfterIt", () => {
    // Before the fix, checkoutPath was spliced inline five separate times.
    const checkoutPath = "/tmp/SENTINEL_CHECKOUTPATH_FC_e1";
    const conflictedPath = "src/SENTINEL_CONFLICT_PATH_e2.ts";
    const prompt = fixConflictsPrompt(checkoutPath, [conflictedPath]);
    assertSentinelsOnlyAfterFinalData(prompt, [checkoutPath, conflictedPath]);
    assertNoInstructionAfterFinalData(prompt);
});

test("test_fixSuitePrompt_hasEveryRuntimeTokenOnlyAfterFinalDataAndNoInstructionAfterIt", () => {
    // Before the fix, subject/checkoutPath were spliced inline four separate times.
    const checkoutPath = "/tmp/SENTINEL_CHECKOUTPATH_FS_f1";
    const occurrenceId = "SENTINEL_LAYER_FS_f2";
    const testOutput = "SENTINEL_FAILUREOUTPUT_FS_f3";
    const forbiddenPath = "SENTINEL_FORBIDDEN_FS_f4";
    const ownedPath = "SENTINEL_OWNED_FS_f5.ts";
    const prompt = fixSuitePrompt(checkoutPath, occurrenceId, testOutput, [forbiddenPath], [ownedPath]);
    assertSentinelsOnlyAfterFinalData(prompt, [checkoutPath, occurrenceId, testOutput, forbiddenPath, ownedPath]);
    assertNoInstructionAfterFinalData(prompt);
});

test("test_fixTestsPrompt_hasEveryRuntimeTokenOnlyAfterFinalDataAndNoInstructionAfterIt", () => {
    const checkoutPath = "/tmp/SENTINEL_CHECKOUTPATH_FT_g1";
    const occurrenceId = "SENTINEL_LAYER_FT_g2";
    const testOutput = "SENTINEL_FAILUREOUTPUT_FT_g3";
    const forbiddenPath = "SENTINEL_FORBIDDEN_FT_g4";
    const ownedPath = "SENTINEL_OWNED_FT_g5.ts";
    const prompt = fixTestsPrompt(checkoutPath, occurrenceId, testOutput, [forbiddenPath], 918273, [ownedPath]);
    assertSentinelsOnlyAfterFinalData(prompt, [checkoutPath, occurrenceId, testOutput, forbiddenPath, ownedPath, "918273"]);
    assertNoInstructionAfterFinalData(prompt);
});

test("test_amendTestsPrompt_hasEveryRuntimeTokenOnlyAfterFinalDataAndNoInstructionAfterIt", () => {
    // Before the fix, testReviewFile was spliced inline in "Read ${t.testReviewFile}, ...".
    const task: PreparedTask = { ...fakeTask, testReviewFile: "/tmp/SENTINEL_TESTREVIEWFILE_AT_h1/test-review.json" };
    const notes = "SENTINEL_NOTES_AT_h2";
    const createdTestFile = "SENTINEL_CREATED_AT_h3.test.ts";
    const testFile = "SENTINEL_FOREIGN_AT_h4.test.ts";
    const prompt = amendTestsPrompt(task, notes, [createdTestFile], [testFile]);
    assertSentinelsOnlyAfterFinalData(prompt, [task.testReviewFile, notes, createdTestFile, testFile]);
    assertNoInstructionAfterFinalData(prompt);
});
