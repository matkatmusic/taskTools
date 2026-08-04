// Computes an occurrence's working-tree delta against a base ref: per-path changes plus an order-independent digest.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export type ComputeOccurrenceTreeDeltaOptions = {
    occurrencePath: string;
    baseRef: string;
    nestedOccurrencePaths?: string[];
    excludePatterns?: string[];
};

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

type TreeEntry = { mode: string; sha: string; path: string };

type RawDiffEntry = {
    oldMode: string;
    newMode: string;
    oldSha: string;
    newSha: string;
    status: string;
    path: string;
    oldPath?: string;
};

function runGit(occurrencePath: string, args: string[], input?: string): string {
    return execFileSync("git", ["-C", occurrencePath, ...args], {
        encoding: "utf8",
        ...(input === undefined ? {} : { input }),
    }).trim();
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

function trackedEntries(occurrencePath: string, excludeSpec: string[]): TreeEntry[] {
    const output = runGit(occurrencePath, ["ls-files", "-s", "--", ".", ...excludeSpec]);
    return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [metadata, path] = line.split("\t");
            const [mode, sha] = metadata.split(" ");
            return { mode, sha, path };
        });
}

function untrackedEntries(occurrencePath: string, paths: string[]): TreeEntry[] {
    return paths.map((path) => {
        const absolutePath = join(occurrencePath, path);
        const stat = lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
            const target = readlinkSync(absolutePath);
            const sha = runGit(occurrencePath, ["hash-object", "--stdin"], target);
            return { mode: "120000", sha, path };
        }
        const mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
        const sha = runGit(occurrencePath, ["hash-object", path]);
        return { mode, sha, path };
    });
}

function buildDigest(entries: TreeEntry[]): string {
    const content = [...entries]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((entry) => `${entry.mode} ${entry.sha} ${entry.path}\n`)
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

    const digest = buildDigest([
        ...trackedEntries(occurrencePath, excludeSpec),
        ...untrackedEntries(occurrencePath, untrackedPaths),
    ]);

    return {
        occurrencePath,
        baseRef,
        changes: [...trackedChanges, ...untrackedChanges],
        digest,
    };
}
