// Builds a local, recursive Git-submodule graph used by the Phase 4 acceptance test.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ordered as discovery walks the tree: each repository's gitlinks in tree order, depth first.
export const REVENG_OCCURRENCE_IDS = [
    "",
    "claude_plugin_lib",
    "jfred",
    "jfred/external/tmux_lib",
    "jfred/jfredToolsPlugin",
    "jfred/jfredToolsPlugin/claude_plugin_lib",
    "jfred/jfredToolsPlugin/external/tmux_lib",
    "jfred/jfredToolsPlugin/scenarios",
    "scenarios",
    "tmux_lib",
] as const;

export const REPEATED_OCCURRENCE_IDS = [
    "tmux_lib",
    "jfred/external/tmux_lib",
    "jfred/jfredToolsPlugin/external/tmux_lib",
    "claude_plugin_lib",
    "jfred/jfredToolsPlugin/claude_plugin_lib",
    "scenarios",
    "jfred/jfredToolsPlugin/scenarios",
] as const;

export type RevengOccurrenceId = (typeof REVENG_OCCURRENCE_IDS)[number];

export type RevengFixture = {
    rootPath: string;
    originPaths: string[];
    occurrencePaths: Record<RevengOccurrenceId, string>;
};

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

// file:// so every origin URL parses to a repository identity; a bare path does not.
function originUrl(originPath: string): string {
    return `file://${originPath}`;
}

function makeBareOrigin(directory: string, name: string): string {
    const originPath = join(directory, `${name}.git`);
    execFileSync("git", ["init", "--bare", "-q", originPath]);
    return originPath;
}

function seedOrigin(directory: string, name: string): string {
    const originPath = makeBareOrigin(directory, name);
    const seedPath = join(directory, `${name}-seed`);
    execFileSync("git", ["clone", "-q", originUrl(originPath), seedPath]);
    git(seedPath, "checkout", "-q", "-b", "main");
    git(seedPath, "config", "user.email", "test@example.com");
    git(seedPath, "config", "user.name", "Test");
    writeFileSync(join(seedPath, "seed.txt"), `${name} seed\n`);
    writeFileSync(join(seedPath, "verify.sh"), "#!/bin/sh\nset -eu\ntest -f seed.txt\n");
    git(seedPath, "add", "seed.txt", "verify.sh");
    git(seedPath, "commit", "-q", "-m", `seed ${name}`);
    git(seedPath, "push", "-q", "-u", "origin", "main");
    return originPath;
}

function addSubmodule(parentPath: string, childOrigin: string, childPath: string): void {
    git(parentPath, "submodule", "add", "-q", "-b", "main", originUrl(childOrigin), childPath);
    git(parentPath, "commit", "-q", "-m", `add ${childPath}`);
}

// The pipeline fetches finalized commits whose gitlinks point at oids the source checkout's submodules never hold.
function disableSubmoduleFetchRecursion(checkoutPath: string): void {
    git(checkoutPath, "config", "fetch.recurseSubmodules", "false");
    git(checkoutPath, "submodule", "foreach", "-q", "--recursive", "git config fetch.recurseSubmodules false");
}

export function makeRevengGraphFixture(): RevengFixture {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const directory = mkdtempSync(join(tmpdir(), "reveng-graph-"));
    const tmuxOrigin = seedOrigin(directory, "tmux-lib");
    const claudeOrigin = seedOrigin(directory, "claude-plugin-lib");
    const scenariosOrigin = seedOrigin(directory, "scenarios");
    const pluginOrigin = seedOrigin(directory, "jfred-tools-plugin");
    const jfredOrigin = seedOrigin(directory, "jfred");
    const rootOrigin = seedOrigin(directory, "root");

    const pluginBuild = join(directory, "jfred-tools-plugin-build");
    execFileSync("git", ["clone", "-q", originUrl(pluginOrigin), pluginBuild]);
    git(pluginBuild, "checkout", "-q", "main");
    git(pluginBuild, "config", "user.email", "test@example.com");
    git(pluginBuild, "config", "user.name", "Test");
    addSubmodule(pluginBuild, tmuxOrigin, "external/tmux_lib");
    addSubmodule(pluginBuild, claudeOrigin, "claude_plugin_lib");
    addSubmodule(pluginBuild, scenariosOrigin, "scenarios");
    git(pluginBuild, "push", "-q", "origin", "main");

    const jfredBuild = join(directory, "jfred-build");
    execFileSync("git", ["clone", "-q", originUrl(jfredOrigin), jfredBuild]);
    git(jfredBuild, "checkout", "-q", "main");
    git(jfredBuild, "config", "user.email", "test@example.com");
    git(jfredBuild, "config", "user.name", "Test");
    addSubmodule(jfredBuild, tmuxOrigin, "external/tmux_lib");
    addSubmodule(jfredBuild, pluginOrigin, "jfredToolsPlugin");
    git(jfredBuild, "push", "-q", "origin", "main");

    const rootPath = join(directory, "root-checkout");
    execFileSync("git", ["clone", "-q", originUrl(rootOrigin), rootPath]);
    git(rootPath, "checkout", "-q", "main");
    git(rootPath, "config", "user.email", "test@example.com");
    git(rootPath, "config", "user.name", "Test");
    addSubmodule(rootPath, tmuxOrigin, "tmux_lib");
    addSubmodule(rootPath, jfredOrigin, "jfred");
    addSubmodule(rootPath, claudeOrigin, "claude_plugin_lib");
    addSubmodule(rootPath, scenariosOrigin, "scenarios");
    git(rootPath, "push", "-q", "origin", "main");
    git(rootPath, "submodule", "update", "--init", "--recursive");
    // Detached with a local main: publication fetches into main, which Git refuses on a checked-out branch.
    git(rootPath, "submodule", "foreach", "-q", "--recursive", "git checkout -q --detach && git branch -f main HEAD");
    disableSubmoduleFetchRecursion(rootPath);

    return {
        rootPath,
        originPaths: [rootOrigin, tmuxOrigin, jfredOrigin, pluginOrigin, claudeOrigin, scenariosOrigin],
        occurrencePaths: {
            "": rootPath,
            tmux_lib: join(rootPath, "tmux_lib"),
            jfred: join(rootPath, "jfred"),
            "jfred/external/tmux_lib": join(rootPath, "jfred/external/tmux_lib"),
            "jfred/jfredToolsPlugin": join(rootPath, "jfred/jfredToolsPlugin"),
            "jfred/jfredToolsPlugin/external/tmux_lib": join(rootPath, "jfred/jfredToolsPlugin/external/tmux_lib"),
            "jfred/jfredToolsPlugin/claude_plugin_lib": join(rootPath, "jfred/jfredToolsPlugin/claude_plugin_lib"),
            "jfred/jfredToolsPlugin/scenarios": join(rootPath, "jfred/jfredToolsPlugin/scenarios"),
            claude_plugin_lib: join(rootPath, "claude_plugin_lib"),
            scenarios: join(rootPath, "scenarios"),
        },
    };
}

export function addRevengGroupWorktree(fixture: RevengFixture, taskNumber: number): string {
    const worktreePath = join(fixture.rootPath, "..", `task-${taskNumber}`);
    git(fixture.rootPath, "worktree", "add", "-q", "-b", `task-group-${taskNumber}`, worktreePath, "main");
    git(worktreePath, "config", "user.email", "test@example.com");
    git(worktreePath, "config", "user.name", "Test");
    git(worktreePath, "submodule", "update", "--init", "--recursive");
    git(worktreePath, "submodule", "foreach", "-q", "--recursive", "git checkout -q --detach && git branch -f main HEAD");
    disableSubmoduleFetchRecursion(worktreePath);
    return worktreePath;
}

export function occurrencePathInWorktree(worktreePath: string, occurrenceId: string): string {
    return occurrenceId === "" ? worktreePath : join(worktreePath, occurrenceId);
}

export function occurrenceChangeFile(occurrenceId: string): string {
    return `changes/${occurrenceId.replaceAll("/", "__")}.txt`;
}
