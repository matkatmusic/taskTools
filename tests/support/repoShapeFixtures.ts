// Builds real Git repo shapes (root, submodules) in staging state, deepest first; never spawns/merges/resets.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeCommittedRepo, addSubmodule } from "./gitFixtures.ts";

export type RepoShape = "none" | "one-submodule" | "two-submodules" | "two-submodules-nested";
export type StagingState = "absent" | "at-head" | "behind-head" | "ahead-head";
export type RepoNode = { occurrenceId: string; checkoutPath: string; headTip: string; stagingTip: string | null };
export type ShapeFixture = { rootPath: string; repos: RepoNode[]; taskNumber: number; priorMergeTip: string | null };

const DEFAULT_BRANCH = "main";

type Tree = { occurrenceId: string; checkoutPath: string; children: Tree[] };

function buildShape(shape: RepoShape): Tree {
    const root = makeCommittedRepo("shape-root-", DEFAULT_BRANCH);
    if (shape === "none") return { occurrenceId: "root", checkoutPath: root, children: [] };
    if (shape === "one-submodule") {
        const sub = addSubmodule(root, makeCommittedRepo("shape-sub-", DEFAULT_BRANCH), "sub");
        return { occurrenceId: "root", checkoutPath: root, children: [{ occurrenceId: "sub", checkoutPath: sub, children: [] }] };
    }
    const subA = addSubmodule(root, makeCommittedRepo("shape-suba-", DEFAULT_BRANCH), "sub-a");
    const subB = addSubmodule(root, makeCommittedRepo("shape-subb-", DEFAULT_BRANCH), "sub-b");
    const subANode: Tree = { occurrenceId: "sub-a", checkoutPath: subA, children: [] };
    if (shape === "two-submodules-nested") {
        const nested = addSubmodule(subA, makeCommittedRepo("shape-nested-", DEFAULT_BRANCH), "nested");
        subANode.children.push({ occurrenceId: "nested", checkoutPath: nested, children: [] });
        // root's earlier gitlink for sub-a predates nested; refresh it to sub-a's HEAD now that nested is in it.
        git(root, "add", "sub-a");
        git(root, "commit", "-q", "-m", "refresh sub-a gitlink after nested added");
    }
    return { occurrenceId: "root", checkoutPath: root, children: [subANode, { occurrenceId: "sub-b", checkoutPath: subB, children: [] }] };
}

// Sets a repo's staging state; children are finalized, so its commit can point gitlinks at them.
function finalizeRepo(node: Tree, children: RepoNode[], state: StagingState, taskNumber: number): RepoNode {
    const repoPath = node.checkoutPath;
    let stagingTip: string | null = null;
    if (state !== "absent") git(repoPath, "branch", "staging");
    if (state === "at-head") {
        stagingTip = git(repoPath, "rev-parse", "staging");
    } else if (state === "behind-head") {
        stagingTip = git(repoPath, "rev-parse", "staging");
        writeFileSync(join(repoPath, "head-advance.txt"), `task-${taskNumber}\n`);
        git(repoPath, "add", "head-advance.txt");
        git(repoPath, "commit", "-q", "-m", `advance head past staging for task ${taskNumber}`);
    } else if (state === "ahead-head") {
        const priorBranch = `task-${taskNumber - 1}`;
        git(repoPath, "checkout", "-q", "-b", priorBranch, "staging");
        writeFileSync(join(repoPath, "prior-task.txt"), `${priorBranch}\n`);
        git(repoPath, "add", "prior-task.txt");
        for (const child of children) {
            if (child.stagingTip === null) continue;
            git(child.checkoutPath, "checkout", "-q", child.stagingTip);
            git(repoPath, "add", child.occurrenceId);
            git(child.checkoutPath, "checkout", "-q", DEFAULT_BRANCH);
        }
        git(repoPath, "commit", "-q", "-m", `${priorBranch} work`);
        git(repoPath, "checkout", "-q", "staging");
        git(repoPath, "merge", "-q", "--no-ff", "-m", `merge ${priorBranch}`, priorBranch);
        stagingTip = git(repoPath, "rev-parse", "staging");
        git(repoPath, "branch", "-D", priorBranch);
        git(repoPath, "checkout", "-q", DEFAULT_BRANCH);
    }
    const headTip = git(repoPath, "rev-parse", DEFAULT_BRANCH);
    return { occurrenceId: node.occurrenceId, checkoutPath: repoPath, headTip, stagingTip };
}

function finalizeTree(node: Tree, state: StagingState, taskNumber: number, out: RepoNode[]): RepoNode {
    const children = node.children.map((child) => finalizeTree(child, state, taskNumber, out));
    const repo = finalizeRepo(node, children, state, taskNumber);
    out.push(repo);
    return repo;
}

export function makeShapeFixture(shape: RepoShape, state: StagingState, taskNumber: number): ShapeFixture {
    const tree = buildShape(shape);
    const repos: RepoNode[] = [];
    const root = finalizeTree(tree, state, taskNumber, repos);
    const priorMergeTip = state === "ahead-head" ? root.stagingTip : null;
    return { rootPath: tree.checkoutPath, repos, taskNumber, priorMergeTip };
}
