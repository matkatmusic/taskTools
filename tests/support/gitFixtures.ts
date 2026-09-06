// Shared real-Git test fixtures (plan rule 9: real submodules, real `git worktree add`, never a
// mock and never a standalone repo standing in for a linked worktree).
//
// Composable builders, small on purpose:
//   - git(repoPath, ...args)            thin `git -C` wrapper, trims stdout.
//   - makeCommittedRepo(prefix?, branch?) one real repo, one commit. The base building block.
//   - addSubmodule(parent, origin, path) `git submodule add` + commit; returns the checked-out path.
//   - makeLayeredSubmoduleFixture()      real root -> child -> grandchild, three origins, fully
//                                        populated. F9 needs the grandchild depth.
//   - makeLinkedWorktree(rootOrigin)     a real `git worktree add`, populated the way the
//                                        production pipeline populates one.
//
// Import only what a test needs; do not add a monolithic "make everything" fixture here.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeForGroup } from "../../scripts/shared/prepareTasks.ts";
import type { TaskGroup } from "../../scripts/shared/taskGroups.ts";

// git >=2.38 blocks file-transport submodule/fetch operations; repo config is ignored in a
// sandboxed test environment, the env var is not.
process.env.GIT_ALLOW_PROTOCOL = "file";

export function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

export function makeCommittedRepo(prefix: string = "git-fixture-", branchName?: string): string {
    const repoPath = mkdtempSync(join(tmpdir(), prefix));
    git(repoPath, ...(branchName ? ["init", "-q", "-b", branchName] : ["init", "-q"]));
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

// Adds submoduleOriginPath as a real submodule of parentRepoPath at relativePath and commits the
// gitlink. Returns the submodule's checked-out path inside the parent, for further commits there.
export function addSubmodule(parentRepoPath: string, submoduleOriginPath: string, relativePath: string): string {
    git(parentRepoPath, "submodule", "add", "-q", submoduleOriginPath, relativePath);
    git(parentRepoPath, "commit", "-q", "-m", `add submodule ${relativePath}`);
    return join(parentRepoPath, relativePath);
}

export type LayeredSubmoduleFixture = {
    grandchildOrigin: string;
    childOrigin: string;
    rootOrigin: string;
};

// Real root repo -> real child submodule -> real grandchild submodule: three separate origins,
// fully populated (`git submodule update --init --recursive`). Every Git-touching test that
// needs "a real layered fixture" (M4) should start here instead of hand-rolling one.
export function makeLayeredSubmoduleFixture(): LayeredSubmoduleFixture {
    const grandchildOrigin = makeCommittedRepo("git-fixture-grandchild-");
    const childOrigin = makeCommittedRepo("git-fixture-child-");
    addSubmodule(childOrigin, grandchildOrigin, "grandchild");
    const rootOrigin = makeCommittedRepo("git-fixture-root-");
    addSubmodule(rootOrigin, childOrigin, "child");
    git(rootOrigin, "submodule", "update", "--init", "--recursive", "-q");
    return { grandchildOrigin, childOrigin, rootOrigin };
}

let nextGroupId = 100_000;

// A real `git worktree add`, populated exactly the way the production pipeline populates one
// (createWorktreeForGroup): every submodule, at every depth, checked out onto task-N.
export function makeLinkedWorktree(rootOrigin: string, groupId: number = nextGroupId++): string {
    const group: TaskGroup = { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" };
    return createWorktreeForGroup(rootOrigin, group);
}
