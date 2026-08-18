// Behavioral checks for scripts/tackle-tasks/AgentPromptEmitter.ts. Run: node --test tests/tackle-tasks/AgentPromptEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    loadPreparedTask,
    type PreparedTask,
} from "../../scripts/tackle-tasks/AgentPromptEmitter.ts";
import { planReviewPrompt } from "../../scripts/tackle-tasks/CodexReviewBodyEmitter.ts";
import { planPrompt } from "../../scripts/tackle-tasks/PlannerBodyEmitter.ts";
import { implementPrompt } from "../../scripts/tackle-tasks/ImplementBodyEmitter.ts";
import { reviewTestsPrompt } from "../../scripts/tackle-tasks/CodexTestReviewBodyEmitter.ts";
import { buildOccurrencePath, buildOwnedOccurrencePaths, type Occurrence } from "../../scripts/tackle-tasks/occurrences.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";

const cliPath = fileURLToPath(new URL("../../scripts/tackle-tasks/AgentPromptEmitter.ts", import.meta.url));

// A hand-built PreparedTask for pure structural tests that never touch a real worktree.
const fakeTask: PreparedTask = {
    number: 99,
    briefFile: "/tmp/fake-worktree/plans/brief-99.md",
    planFile: "/tmp/fake-worktree/plans/plan.json",
    reviewFile: "/tmp/fake-worktree/plans/codex-review.json",
    reviewOutputFile: "/tmp/fake-worktree/plans/codex-review.json",
    testReviewFile: "/tmp/fake-worktree/plans/test-review.json",
    notesFile: "/tmp/fake-worktree/plans/implementation-notes-99.md",
    files: ["src/thing.ts"],
    ownedFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
    testFilePaths: [],
    tests: "node --test tests/thing.test.ts",
    codexReviewNotes: "",
    repoRoot: "/tmp/fake-worktree",
    taskStateRoot: "/tmp/fake-worktree",
};

// Sets up a project root with a task record, and a brief file already written into the worktree (loadPreparedTask is read-only now — it never creates the brief itself).
function makeFixture(taskNumber = 42): { projectRoot: string; worktree: string; task: PreparedTask } {
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-prompt-emitter-"));
    // A recorded red suite, so the fix-suite role has the failing output it derives from state.
    const run = {
        runId: "run-1", startedAt: "2026-08-18T00:00:00", endedAt: null, exitType: null, exitNote: null,
        modifiedFiles: [], commits: [], implementationNotesFile: null,
        taskTests: {
            stepId: "run task tests", testFiles: ["tests/thing.test.ts"], createdTestFiles: ["tests/thing.test.ts"],
            deletedTestFiles: [], missingTests: false, passed: true, output: "1 passing", checkedAt: "2026-08-18T00:00:00",
        },
        fullSuite: { stepId: "run the full suite", layers: [{ occurrenceId: "", passed: false }], passed: false, output: "1 failing", checkedAt: "2026-08-18T00:00:00" },
    };
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify([
        {
            taskNumber, title: "sample task", files: ["src/thing.ts"], tests: "node --test tests/thing.test.ts",
            run: { active: true, worktree: null, leaseRunId: null, history: [run] },
        },
    ]));
    writeFileSync(join(projectRoot, "completedTasks.json"), "[]");
    // A real subdirectory, not projectRoot: aliasing them hides whether a write hit the worktree.
    const worktree = join(projectRoot, "worktree");
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, "plans", `brief-${taskNumber}.md`), `# fixture sentinel brief for task ${taskNumber}\n`);
    // A branched repo, because review-tests derives this task's diff against the source branch.
    const git = (...args: string[]) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("commit", "--quiet", "--allow-empty", "-m", "base");
    git("checkout", "--quiet", "-b", `task-${taskNumber}`);
    git("commit", "--quiet", "--allow-empty", "-m", "task work");
    const task = loadPreparedTask(taskNumber, worktree, projectRoot);
    return { projectRoot, worktree, task };
}

// A repository stopped mid-merge on a real unmerged path; fix-conflicts derives its file list from git.
function makeConflictedRepo(): string {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    const repo = mkdtempSync(join(tmpdir(), "agent-prompt-conflict-"));
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "thing.ts"), "one\n");
    git("add", "thing.ts");
    git("commit", "--quiet", "-m", "base");
    git("checkout", "--quiet", "-b", "other");
    writeFileSync(join(repo, "thing.ts"), "two\n");
    git("commit", "--quiet", "-am", "other side");
    git("checkout", "--quiet", "main");
    writeFileSync(join(repo, "thing.ts"), "three\n");
    git("commit", "--quiet", "-am", "main side");
    try {
        git("merge", "other");
    } catch {
        // A conflicting merge exits nonzero; that stopped state is exactly the fixture.
    }
    return repo;
}

// Every eight-role prompt, built from one shared fixture, for tests that check a property over all of them.
function allRolePrompts(task: PreparedTask): Record<string, string> {
    return {
        plan: planPrompt(task),
        "review-plan": planReviewPrompt(task),
        implement: implementPrompt(task, "npx tsc --noEmit", 3, "run-1", "main"),
        "review-tests": reviewTestsPrompt(task, "main"),
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
    // Setup: both review roles now carry their own copy of the chain, so assert they still agree.
    const { task } = makeFixture(47);
    for (const chain of [planReviewPrompt(task), reviewTestsPrompt(task, "main")]) {
        assert.match(chain, /codex exec -s read-only/);
        assert.match(chain, /claude -p .* --tools "Read" --model fable --effort medium/);
        assert.match(chain, /claude -p .* --tools "Read" --model claude-opus-4-8 --effort high/);
    }
});

test("test_noPromptContainsAGitCommand", () => {
    // Setup: every role's prompt, from a single fixture.
    const { task } = makeFixture(43);
    const prompts = allRolePrompts(task);

    // One regex catches every actual git-invocation shape v1_1 used to run: `git -C`, `git add`, `git commit`, etc. Rule 1 says the commit box owns committing, so none may survive here.  A prose mention naming a git subcommand only to forbid running it (kept verbatim per the plan's mapping table, e.g. "do not run `git rebase --continue`") never matches this shape.
    const gitCommandPattern = /\bgit\s+(-C\b|add\b|commit\b|push\b|checkout\b|reset\b|merge\b|rm\b)/;

    for (const [role, prompt] of Object.entries(prompts)) {
        assert.equal(gitCommandPattern.test(prompt), false, `role "${role}" contains a git command`);
    }
});

// ---------------------------------------------------------------------------
// Phase 10 audit finding 6 — amendTestsPrompt must derive the pre-existing list from testFiles minus createdTestFiles (never trust the caller's subtraction), and must resolve every occurrence-tagged path to a real absolute path in the worktree, including inside a nested submodule occurrence. A real submodule and a real `git worktree add` are used throughout, per global rule 9 — no mock, no standalone repo standing in for a linked worktree.
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

// A real linked worktree (root + submodule checked out via `git worktree add`), with tasks.json and the brief already in place so loadPreparedTask succeeds.
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

// Writes and commits a real file at relativePath inside checkoutPath, so occurrence resolution has something real on disk to point at (not just a string it happens to compute correctly).
function commitRealFile(checkoutPath: string, relativePath: string, contents: string): void {
    mkdirSync(join(checkoutPath, join(relativePath, "..")), { recursive: true });
    writeFileSync(join(checkoutPath, relativePath), contents);
    git(checkoutPath, "add", relativePath);
    git(checkoutPath, "commit", "-q", "-m", `add ${relativePath}`);
}

// Parses every "- taggedPath => absolutePath" edit-path line out of one DATA section of a rendered amend-tests prompt, so assertions test what the agent actually receives rather than a path recomputed independently in the test.
function parseEmittedTestFileEntries(section: string): Array<{ taggedPath: string; absolutePath: string }> {
    return section.split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => {
            const [taggedPath, absolutePath] = line.slice(2).split(" => ");
            return { taggedPath, absolutePath };
        });
}

test("test_planPrompt_putsCodexReviewNotesAtTheTop", () => {
    // Setup: a task whose entry carries codex's notes from the previous review round.
    const withNotes = { ...fakeTask, codexReviewNotes: "the plan skipped the migration step" };
    // Test action: build the planner prompt for it.
    const prompt = planPrompt(withNotes);
    // Test verification: the notes appear, and before the job description the planner then reads.
    assert.match(prompt, /the plan skipped the migration step/);
    assert.ok(prompt.indexOf("CODEX'S PREVIOUS REVIEW NOTES") < prompt.indexOf("## YOUR JOB"));
});

test("test_planPrompt_omitsTheNotesSectionWhenThereAreNone", () => {
    // Setup and action: the default fixture has no notes.
    const prompt = planPrompt(fakeTask);
    // Test verification: a first planning round shows no review section at all.
    assert.ok(!prompt.includes("CODEX'S PREVIOUS REVIEW NOTES"));
});

for (const [role, buildPrompt] of Object.entries({
    plan: (task: PreparedTask) => planPrompt(task),
    "review-plan": (task: PreparedTask) => planReviewPrompt(task),
    implement: (task: PreparedTask) => implementPrompt(task, "npx tsc --noEmit", 3, "run-1", "main"),
    "review-tests": (task: PreparedTask) => reviewTestsPrompt(task, "main"),
})) {
    test(`test_${role.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Prompt_leavesNoUnresolvedInterpolation`, () => {
        const { task } = makeFixture();
        const prompt = buildPrompt(task);
        assert.equal(prompt.includes("${"), false);
        assert.equal(prompt.includes("$ARGUMENTS"), false);
    });
}

// ---------------------------------------------------------------------------
// Finding 6 — loadPreparedTask must be read-only: it derives/validates the brief path but never writes it, and fails explicitly when the brief is missing.
// ---------------------------------------------------------------------------

test("test_loadPreparedTask_doesNotRewriteTheBriefFile", () => {
    // Setup: a fixture whose brief file holds sentinel content that generateTaskBriefContents would never produce (it does not know about this exact sentence).
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

    // Verification: it fails loudly instead of silently writing the brief and succeeding. The old code called writeTaskBrief() here, would have exited 0, and left a brief on disk.
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
                // review-tests writes this one generated artifact for the read-only reviewer to open.
                else if (/\/plans\/implementation-diff-\d+\.patch$/.test(full)) continue;
                // git's own background maintenance creates and removes this; no role writes it.
                else if (/\/\.git\/objects\/maintenance\.lock$/.test(full)) continue;
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
        ["fix-conflicts", { checkoutPath: makeConflictedRepo() }],
        ["run-task-tests", {}],
        ["rebase-worktree", {}],
        ["continue-rebase", {}],
        ["run-full-suite", {}],
        ["fix-suite", {}],
    ];

    // Test action: invoke every CLI role classified read-only against this one worktree.
    for (const [role, extra] of roleInvocations) {
        const payload = JSON.stringify({ worktree, projectRoot, sourceBranch: "main", runId: "run-1", ...extra });
        const result = spawnSync("node", [cliPath, "52", role], { input: payload, encoding: "utf8" });
        assert.equal(result.status, 0, `role "${role}" exited nonzero: ${result.stderr}`);
    }

    // Verification: no file bytes or paths changed. The old code would have rewritten plans/brief-52.md on every role that plans/reviews/implements/amends.
    const after = snapshotTree(worktree);
    assert.deepEqual(after, before);
});

// ---------------------------------------------------------------------------
// Finding 7 — every role's return instruction is exactly the Phase 9 table shape; the old v1.1 fields (task, status, planFile, question, missingFiles, summary) are gone.
// ---------------------------------------------------------------------------

test("test_planPrompt_pointsAtTheReturnShapeTemplate", () => {
    // Setup and action: build the planner prompt.
    const prompt = planPrompt(fakeTask);
    // Test verification: it cites the template file rather than inlining a return shape.
    assert.match(prompt, /plan-output-template\.json/);
    assert.ok(!prompt.includes("planWritten"));
});
test("test_planReviewPrompt_returnsWhatTheRulingScriptPrinted", () => {
    // The script owns the verdict; the agent must not decide one itself.
    const prompt = planReviewPrompt(fakeTask);
    assert.match(prompt, /recordPlanReview\.ts/);
    assert.match(prompt, /never decide a verdict yourself/);
    assert.equal(prompt.includes("reviewWritten"), false);
    // The reviewer writes its answer here, and the ruling script reads it back from the same path.
    assert.match(prompt, new RegExp(`REVIEW_FILE=${fakeTask.reviewOutputFile}`));
});

test("test_planReviewPrompt_emitsOneQuestionEveryReviewerCanUse", () => {
    // /read-file is a Claude skill codex cannot invoke, so the question itself names paths instead.
    const prompt = planReviewPrompt(fakeTask);
    const question = prompt.slice(prompt.indexOf("REVIEWEOF'"), prompt.indexOf("\nREVIEWEOF\n"));
    assert.equal(question.includes("/read-file"), false);
    assert.match(question, new RegExp(`- ${fakeTask.planFile}`));
    // The error example is spliced from its template, so the prompt cannot drift from the schema.
    const errorTemplate = readFileSync(
        fileURLToPath(new URL("../../plans/review-plan-error-template.json", import.meta.url)), "utf8",
    );
    assert.ok(question.includes(errorTemplate.trim()), "missing-file example is not the template verbatim");
    const schema = JSON.parse(readFileSync(
        fileURLToPath(new URL("../../plans/review-plan-schema.json", import.meta.url)), "utf8",
    ));
    // Every field the schema requires must be present, or codex rejects the error response.
    assert.deepEqual(Object.keys(JSON.parse(errorTemplate)).sort(), [...schema.required].sort());
    // One question serves all three commands, so its body may only be emitted once.
    assert.equal(prompt.split("## HOW TO JUDGE THE PLAN").length - 1, 1);
    assert.equal(prompt.split("REVIEW_PROMPT=").length - 1, 1);
});

test("test_planReviewPrompt_keepsTheHeredocAndItsCommandsInOneRunnableBlock", () => {
    // A shell variable dies with its Bash call, so the assignment must sit inside the fence it feeds.
    const prompt = planReviewPrompt(fakeTask);
    const fence = prompt.slice(prompt.indexOf("````sh"), prompt.lastIndexOf("````"));
    assert.match(fence, /REVIEW_PROMPT=\$\(cat <<'REVIEWEOF'/);
    // -o keeps codex's banner out of the answer; </dev/null stops it blocking on stdin forever.  --output-schema is what makes codex emit bare JSON instead of a fenced block with prose.
    assert.match(fence, /codex exec -s read-only --output-schema \S+review-plan-schema\.json -o "\$REVIEW_FILE" "\$REVIEW_PROMPT" <\/dev\/null/);
    for (const line of fence.split("\n").filter((l) => /^\s*(codex exec|\|\| claude -p)/.test(l))) {
        assert.match(line, /<\/dev\/null/, `reviewer command can hang on stdin: ${line}`);
    }
    assert.match(fence, /recordPlanReview\.ts/);
    // Four backticks, so a fenced block inside the question cannot close the wrapper early.
    assert.match(fence, /REVIEWEOF\n\)/);
});

test("test_planReviewPrompt_citesBothTemplatesInsteadOfInliningTheirJson", () => {
    // Two shapes at two layers: the CLI reviewer returns issues/fixes, the subagent returns the verdict.
    const prompt = planReviewPrompt(fakeTask);
    assert.match(prompt, /review-plan-template\.json/);
    assert.match(prompt, /review-plan-output-template\.json/);
    // Field names appear in the missing-file example; the template's placeholder prose must not.
    assert.equal(prompt.includes("<the id of the plan section this issue is in"), false);
    assert.equal(prompt.includes("<why this will not regress the same way>"), false);
});




// ---------------------------------------------------------------------------
// Finding 8 — fix-suite/fix-tests may only edit the occurrence-appropriate owned source paths; the whole checkout is never the edit boundary.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Finding 9 — every builder puts static instructions and the return contract first, and appends all runtime/bulk data after a final "---- DATA ----" marker.
// ---------------------------------------------------------------------------




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

// A nested codex review carries its own DATA section because codex receives only the question string; that data cannot move to the outer final section. It must still come last within the question, so assert it against the first marker rather than the last.
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

test("test_reviewPlanPrompt_namesTheBriefPlanAndOwnedPathsForTheReviewer", () => {
    // Codex only gets the question string, so every path it must read is interpolated into it.
    const task: PreparedTask = {
        ...fakeTask,
        briefFile: "/tmp/SENTINEL_BRIEF_RP_b2/brief.md",
        planFile: "/tmp/SENTINEL_PLANFILE_RP_b3/plan.json",
        ownedFilePaths: ["/tmp/SENTINEL_OWNED_RP_b4/thing.ts"],
    };
    const prompt = planReviewPrompt(task);
    for (const path of [task.briefFile, task.planFile, task.ownedFilePaths[0]]) {
        assert.ok(prompt.includes(path), `prompt is missing ${path}`);
    }
    assert.equal(prompt.includes("---- DATA ----"), false);
});




