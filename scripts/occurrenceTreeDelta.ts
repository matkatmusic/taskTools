// Computes an occurrence's working-tree delta against a base ref: per-path changes plus an order-independent digest.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export interface OccurrenceTreeSpec {
    occurrencePath: string;
    nestedOccurrencePaths?: string[];
    excludePatterns?: string[];
}

export type ComputeOccurrenceTreeDeltaOptions = OccurrenceTreeSpec & { baseRef: string };

export type TreeChangeKind = "added" | "modified" | "deleted" | "renamed" | "mode-changed" | "symlink" | "untracked";

export type TreeChange = {
    path: string;
    kind: TreeChangeKind;
    oldPath?: string;
    oldMode?: string;
    newMode?: string;
};

export type OccurrenceTreeDelta = {
    occurrencePath: string;
    baseRef: string;
    changes: TreeChange[];
    digest: string;
};

type SnapshotEntry = { path: string; mode: string; contentHash: string };

export type TreePatchKind = "add" | "delete" | "modify" | "mode-changed" | "renamed";

export type TreePatch = {
    path: string;
    kind: TreePatchKind;
    oldPath?: string;
    mode?: string;
};

type RawDiffEntry = {
    oldMode: string;
    newMode: string;
    oldSha: string;
    newSha: string;
    status: string;
    path: string;
    oldPath?: string;
};

function runGit(occurrencePath: string, args: string[]): string {
    return execFileSync("git", ["-C", occurrencePath, ...args], { encoding: "utf8" }).trim();
}

function buildExcludeSpec(nestedOccurrencePaths: string[], excludePatterns: string[]): string[] {
    return [...nestedOccurrencePaths, ...excludePatterns].map((pattern) => `:(exclude)${pattern}`);
}

function parseRawDiffLine(line: string): RawDiffEntry {
    const [metadata, ...paths] = line.split("\t");
    const [oldModeRaw, newMode, oldSha, newSha, status] = metadata.split(" ");
    return {
        oldMode: oldModeRaw.replace(/^:/, ""),
        newMode,
        oldSha,
        newSha,
        status,
        path: paths[paths.length - 1],
        oldPath: paths.length > 1 ? paths[0] : undefined,
    };
}

function classify(entry: RawDiffEntry): TreeChangeKind {
    if (entry.oldMode === "120000" || entry.newMode === "120000") return "symlink";
    if (entry.status.startsWith("R")) return "renamed";
    if (entry.oldSha === entry.newSha && entry.oldMode !== entry.newMode) return "mode-changed";
    if (entry.status.startsWith("A")) return "added";
    if (entry.status.startsWith("D")) return "deleted";
    return "modified";
}

function toTreeChange(entry: RawDiffEntry): TreeChange {
    const kind = classify(entry);
    const change: TreeChange = { path: entry.path, kind, oldMode: entry.oldMode, newMode: entry.newMode };
    if (kind === "renamed") change.oldPath = entry.oldPath;
    return change;
}

function buildIncludedPaths(spec: OccurrenceTreeSpec): string[] {
    const excludeSpec = buildExcludeSpec(spec.nestedOccurrencePaths ?? [], spec.excludePatterns ?? []);
    const tracked = runGit(spec.occurrencePath, ["ls-files", "--", ".", ...excludeSpec])
        .split("\n")
        .filter(Boolean);
    const untracked = runGit(spec.occurrencePath, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        ".",
        ...excludeSpec,
    ])
        .split("\n")
        .filter(Boolean);
    return [...new Set([...tracked, ...untracked])];
}

function buildSnapshot(spec: OccurrenceTreeSpec): SnapshotEntry[] {
    const entries: SnapshotEntry[] = [];
    for (const path of buildIncludedPaths(spec)) {
        const absolutePath = join(spec.occurrencePath, path);
        let stat;
        try {
            stat = lstatSync(absolutePath);
        } catch {
            continue;
        }
        if (stat.isSymbolicLink()) {
            const target = readlinkSync(absolutePath);
            entries.push({ path, mode: "120000", contentHash: createHash("sha256").update(target).digest("hex") });
        } else {
            const bytes = readFileSync(absolutePath);
            const mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
            entries.push({ path, mode, contentHash: createHash("sha256").update(bytes).digest("hex") });
        }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function buildDigest(entries: SnapshotEntry[]): string {
    const content = [...entries]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((entry) => `${entry.mode} ${entry.contentHash} ${entry.path}\n`)
        .join("");
    return createHash("sha256").update(content).digest("hex");
}

export async function computeOccurrenceTreeDelta(
    options: ComputeOccurrenceTreeDeltaOptions,
): Promise<OccurrenceTreeDelta> {
    const { occurrencePath, baseRef, nestedOccurrencePaths = [], excludePatterns = [] } = options;
    const excludeSpec = buildExcludeSpec(nestedOccurrencePaths, excludePatterns);

    const trackedChanges = runGit(occurrencePath, ["diff", "--raw", "-M", baseRef, "--", ".", ...excludeSpec])
        .split("\n")
        .filter(Boolean)
        .map(parseRawDiffLine)
        .map(toTreeChange);

    const untrackedPaths = runGit(occurrencePath, ["ls-files", "--others", "--exclude-standard", "--", ".", ...excludeSpec])
        .split("\n")
        .filter(Boolean);
    const untrackedChanges: TreeChange[] = untrackedPaths.map((path) => ({ path, kind: "untracked" }));

    const digest = buildDigest(buildSnapshot({ occurrencePath, nestedOccurrencePaths, excludePatterns }));

    return {
        occurrencePath,
        baseRef,
        changes: [...trackedChanges, ...untrackedChanges],
        digest,
    };
}

export async function computeTreeDigest(occurrence: OccurrenceTreeSpec): Promise<string> {
    return buildDigest(buildSnapshot(occurrence));
}

export async function computeTreeDelta(
    source: OccurrenceTreeSpec,
    target: OccurrenceTreeSpec,
): Promise<TreePatch[]> {
    const sourceEntries = buildSnapshot(source);
    const targetEntries = buildSnapshot(target);
    const sourceByPath = new Map(sourceEntries.map((entry) => [entry.path, entry]));
    const targetByPath = new Map(targetEntries.map((entry) => [entry.path, entry]));

    const patches: TreePatch[] = [];
    const sourceOnly: SnapshotEntry[] = [];
    const targetOnly: SnapshotEntry[] = [];
    const allPaths = [...new Set([...sourceByPath.keys(), ...targetByPath.keys()])].sort((a, b) =>
        a.localeCompare(b),
    );

    for (const path of allPaths) {
        const s = sourceByPath.get(path);
        const t = targetByPath.get(path);
        if (s && t) {
            if (s.contentHash !== t.contentHash) {
                patches.push({ path, kind: "modify", mode: s.mode });
            } else if (s.mode !== t.mode) {
                patches.push({ path, kind: "mode-changed", mode: s.mode });
            }
        } else if (s && !t) {
            sourceOnly.push(s);
        } else if (t && !s) {
            targetOnly.push(t);
        }
    }

    const keyOf = (entry: SnapshotEntry) => `${entry.mode}:${entry.contentHash}`;
    const groupBy = (entries: SnapshotEntry[]) => {
        const groups = new Map<string, SnapshotEntry[]>();
        for (const entry of entries) {
            const key = keyOf(entry);
            const group = groups.get(key);
            if (group) group.push(entry);
            else groups.set(key, [entry]);
        }
        return groups;
    };
    const sourceGroups = groupBy(sourceOnly);
    const targetGroups = groupBy(targetOnly);
    const pairedSourcePaths = new Set<string>();
    const pairedTargetPaths = new Set<string>();

    for (const [key, sourceGroup] of sourceGroups) {
        const targetGroup = targetGroups.get(key);
        if (targetGroup && sourceGroup.length === 1 && targetGroup.length === 1) {
            patches.push({
                path: sourceGroup[0].path,
                kind: "renamed",
                oldPath: targetGroup[0].path,
                mode: sourceGroup[0].mode,
            });
            pairedSourcePaths.add(sourceGroup[0].path);
            pairedTargetPaths.add(targetGroup[0].path);
        }
    }

    for (const entry of sourceOnly) {
        if (!pairedSourcePaths.has(entry.path)) patches.push({ path: entry.path, kind: "add", mode: entry.mode });
    }
    for (const entry of targetOnly) {
        if (!pairedTargetPaths.has(entry.path)) patches.push({ path: entry.path, kind: "delete" });
    }

    return patches.sort((a, b) => a.path.localeCompare(b.path));
}
