// reviewPlanBrief.ts: splits plan from target, normalises the plan to plans/, and emits the resolved brief.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { amendmentPath, repoRelativePlanPath, splitPlanPath } from "../scripts/reviewPlanBrief.ts";

const scriptPath = new URL("../scripts/reviewPlanBrief.ts", import.meta.url).pathname;

function runScript(argumentString: string, cwd?: string): string {
  return execFileSync("node", [scriptPath], { input: argumentString, encoding: "utf8", cwd });
}

test("splits an unquoted plan path from the target", () => {
  const parsed = splitPlanPath("plans/ultra-fuzzy-star.md the state of the codebase");
  assert.equal(parsed.planPath, "plans/ultra-fuzzy-star.md");
  assert.equal(parsed.target, "the state of the codebase");
});

test("keeps a quoted plan path containing spaces intact", () => {
  const parsed = splitPlanPath('"plans/ultra fuzzy star.md" the codebase on new-usage-graph');
  assert.equal(parsed.planPath, "plans/ultra fuzzy star.md");
  assert.equal(parsed.target, "the codebase on new-usage-graph");
});

test("returns an empty target when only a plan path is given", () => {
  assert.equal(splitPlanPath("plans/p.md").target, "");
});

test("rewrites a plan path from outside the repo to the plans/ copy", () => {
  assert.equal(repoRelativePlanPath("/tmp/somewhere/else/ultra-fuzzy-star.md"), "plans/ultra-fuzzy-star.md");
  assert.equal(repoRelativePlanPath("/Users/me/taskTools/plans/ultra-fuzzy-star.md"), "plans/ultra-fuzzy-star.md");
});

test("keeps a subdirectory that already sits under plans/", () => {
  assert.equal(repoRelativePlanPath("/Users/me/taskTools/plans/archived/old.md"), "plans/archived/old.md");
  assert.equal(amendmentPath("/Users/me/taskTools/plans/archived/old.md"), "plans/archived/old-amendment.md");
});

test("names the amendment file next to the plan copy, without the .md suffix", () => {
  assert.equal(amendmentPath("/tmp/elsewhere/ultra-fuzzy-star.md"), "plans/ultra-fuzzy-star-amendment.md");
});

test("emits a brief naming the plans/ copy, the target, and the amendment file, all absolute", () => {
  // realpathSync: the script reports its cwd resolved, and macOS symlinks /var onto /private/var.
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "review-plan-")));
  const source = join(projectRoot, "elsewhere", "ultra-fuzzy-star.md");
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, "original plan\n");

  const brief = runScript(`${source} the codebase's state, isn't it`, projectRoot);
  assert.ok(brief.includes(`review ${join(projectRoot, "plans", "ultra-fuzzy-star.md")} against the codebase's state, isn't it.`));
  assert.ok(brief.includes(`may create or modify is ${join(projectRoot, "plans", "ultra-fuzzy-star-amendment.md")}.`));
  assert.doesNotMatch(brief, /\/elsewhere\//);
  assert.doesNotMatch(brief, /[^/]plans\/ultra-fuzzy-star\.md/);
});

test("copies an out-of-repo plan into plans/ and leaves an existing copy alone", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "review-plan-"));
  const source = join(projectRoot, "outside", "ultra-fuzzy-star.md");
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, "original plan\n");

  const destination = join(projectRoot, "plans", "ultra-fuzzy-star.md");
  execFileSync("node", [scriptPath], { input: `${source} the codebase`, encoding: "utf8", cwd: projectRoot });
  assert.equal(readFileSync(destination, "utf8"), "original plan\n");

  writeFileSync(destination, "already reviewed\n");
  execFileSync("node", [scriptPath], { input: `${source} the codebase`, encoding: "utf8", cwd: projectRoot });
  assert.equal(readFileSync(destination, "utf8"), "already reviewed\n");
});

test("does not copy when the plan already lives in plans/", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "review-plan-"));
  const plan = join(projectRoot, "plans", "p.md");
  mkdirSync(dirname(plan), { recursive: true });
  writeFileSync(plan, "in place\n");
  execFileSync("node", [scriptPath], { input: `${plan} the codebase`, encoding: "utf8", cwd: projectRoot });
  assert.equal(readFileSync(plan, "utf8"), "in place\n");
});

function runExpectingFailure(input: string): string {
  try {
    execFileSync("node", [scriptPath], { input, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    return String((error as { stderr: string }).stderr);
  }
  return "";
}

test("fails loudly rather than emitting a brief that points nowhere", () => {
  assert.match(runExpectingFailure(""), /no plan file path on stdin/);
  assert.match(runExpectingFailure("plans/p.md"), /no target given after the plan file path/);
  assert.match(runExpectingFailure("/tmp/nope/missing.md the codebase"), /plan file does not exist/);
});

test("emits the amendment template with its fenced block intact", () => {
  const plan = join(mkdtempSync(join(tmpdir(), "review-plan-")), "plans", "p.md");
  mkdirSync(dirname(plan), { recursive: true });
  writeFileSync(plan, "# Plan\n");
  const brief = runScript(`${plan} the codebase`);
  assert.match(brief, /```markdown\n# Amendment: <plan title>/);
  assert.match(brief, /- Reviewed against: the codebase\n/);
});
