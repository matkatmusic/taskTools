// Before/after filesystem snapshots per occurrence, diffed independent of commit history (Phase 3 of the recursive repository-discovery redesign).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import type { OwnershipEffects } from "./ownershipKeys.ts";

export type PathState = {
    path: string;
    kind: "file" | "symlink" | "dir";
    mode: string;
    hash: string | null;
};

export type Snapshot = Map<string, PathState>;

function listCandidatePaths(occurrenceRoot: string): string[] {
    const tracked = execFileSync("git", ["-C", occurrenceRoot, "ls-files", "-z"], { encoding: "utf8" });
    const untracked = execFileSync(
        "git",
        ["-C", occurrenceRoot, "ls-files", "--others", "--exclude-standard", "-z"],
        { encoding: "utf8" },
    );
    const paths = [...tracked.split("\0"), ...untracked.split("\0")]
        .filter(Boolean)
        .map((path) => path.replace(/\/$/, ""));
    return [...new Set(paths)];
}

function readPathState(occurrenceRoot: string, path: string): PathState {
    const absolutePath = join(occurrenceRoot, path);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolutePath);
        return { path, kind: "symlink", mode: "120000", hash: createHash("sha1").update(target).digest("hex") };
    }
    if (stat.isDirectory()) {
        return { path, kind: "dir", mode: "040000", hash: null };
    }
    const mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
    const hash = createHash("sha1").update(readFileSync(absolutePath)).digest("hex");
    return { path, kind: "file", mode, hash };
}

export function takeSnapshot(occurrenceRoot: string): Snapshot {
    const snapshot: Snapshot = new Map();
    for (const path of listCandidatePaths(occurrenceRoot)) {
        try {
            snapshot.set(path, readPathState(occurrenceRoot, path));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    return snapshot;
}

export type ChangeType = "added" | "deleted" | "modified" | "mode-changed" | "symlink-changed" | "renamed";

export type Change = {
    occurrenceRoot: string;
    path: string;
    type: ChangeType;
    fromPath?: string;
};

// ponytail: exact-hash rename match only, add similarity scoring if renamed+edited-in-one-step needs attribution
function pairRenames(added: PathState[], deleted: PathState[]): { renames: Change[]; consumed: Set<string> } {
    const renames: Change[] = [];
    const consumed = new Set<string>();
    for (const addedEntry of added) {
        if (addedEntry.hash === null) continue;
        const match = deleted.find((entry) => entry.hash === addedEntry.hash && !consumed.has(entry.path));
        if (!match) continue;
        renames.push({ occurrenceRoot: "", path: addedEntry.path, type: "renamed", fromPath: match.path });
        consumed.add(addedEntry.path);
        consumed.add(match.path);
    }
    return { renames, consumed };
}

export function diffSnapshots(occurrenceRoot: string, before: Snapshot, after: Snapshot): Change[] {
    const addedOnly: PathState[] = [];
    const deletedOnly: PathState[] = [];
    const changes: Change[] = [];

    for (const key of new Set([...before.keys(), ...after.keys()])) {
        const beforeState = before.get(key);
        const afterState = after.get(key);
        if (beforeState && !afterState) {
            deletedOnly.push(beforeState);
        } else if (!beforeState && afterState) {
            addedOnly.push(afterState);
        } else if (beforeState && afterState) {
            if (beforeState.kind !== afterState.kind) {
                changes.push({ occurrenceRoot, path: key, type: "symlink-changed" });
            } else if (beforeState.hash !== afterState.hash) {
                changes.push({ occurrenceRoot, path: key, type: "modified" });
            } else if (beforeState.mode !== afterState.mode) {
                changes.push({ occurrenceRoot, path: key, type: "mode-changed" });
            }
        }
    }

    const { renames, consumed } = pairRenames(addedOnly, deletedOnly);
    for (const rename of renames) changes.push({ ...rename, occurrenceRoot });
    for (const entry of addedOnly) {
        if (!consumed.has(entry.path)) changes.push({ occurrenceRoot, path: entry.path, type: "added" });
    }
    for (const entry of deletedOnly) {
        if (!consumed.has(entry.path)) changes.push({ occurrenceRoot, path: entry.path, type: "deleted" });
    }
    return changes;
}

// Reassigns a change to the deepest occurrence root whose directory actually contains it.
export function attributeOccurrence(change: Change, occurrenceRoots: string[]): Change {
    const absolutePath = join(change.occurrenceRoot, change.path);
    const deepestRoot = [...occurrenceRoots]
        .sort((a, b) => b.length - a.length)
        .find((root) => absolutePath === root || absolutePath.startsWith(`${root}/`));
    if (!deepestRoot || deepestRoot === change.occurrenceRoot) return change;
    return { ...change, occurrenceRoot: deepestRoot, path: relative(deepestRoot, absolutePath) };
}

export type Violation = {
    occurrenceId: string;
    path: string;
    type: ChangeType;
    reason: "out-of-ownership";
};

function isCovered(change: Change, ownershipKeys: OwnershipEffects[]): boolean {
    const absolutePath = join(change.occurrenceRoot, change.path);
    return ownershipKeys.some((effect) => effect.occurrencePaths.includes(absolutePath));
}

export function checkOwnership(workerId: string, changes: Change[], ownershipKeys: OwnershipEffects[]): Violation[] {
    return changes
        .filter((change) => !isCovered(change, ownershipKeys))
        .map((change) => ({
            occurrenceId: change.occurrenceRoot,
            path: change.path,
            type: change.type,
            reason: "out-of-ownership",
        }));
}

export function checkGroupBoundary(changes: Change[], allWorkersOwnershipKeys: OwnershipEffects[][]): Violation[] {
    return changes
        .filter((change) => !allWorkersOwnershipKeys.some((ownershipKeys) => isCovered(change, ownershipKeys)))
        .map((change) => ({
            occurrenceId: change.occurrenceRoot,
            path: change.path,
            type: change.type,
            reason: "out-of-ownership",
        }));
}
