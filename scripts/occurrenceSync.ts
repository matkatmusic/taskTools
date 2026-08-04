// Deterministic N-way synchronization: star topology, source as sole authority.
import { chmodSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { computeTreeDelta, computeTreeDigest } from "./occurrenceTreeDelta.ts";
import type { OccurrenceTreeSpec, TreePatch } from "./occurrenceTreeDelta.ts";

export interface SyncResult {
    converged: boolean;
    iterations: number;
    changedPaths: Record<string, string[]>;
}

function modeToOctal(mode?: string): number {
    return mode === "100755" ? 0o755 : 0o644;
}

function applyTreePatch(sourceSpec: OccurrenceTreeSpec, targetSpec: OccurrenceTreeSpec, patch: TreePatch): void {
    const targetAbs = join(targetSpec.occurrencePath, patch.path);
    try {
        mkdirSync(dirname(targetAbs), { recursive: true });
        switch (patch.kind) {
            case "delete":
                rmSync(targetAbs, { force: true });
                break;
            case "renamed": {
                const oldAbs = join(targetSpec.occurrencePath, patch.oldPath!);
                rmSync(targetAbs, { force: true });
                renameSync(oldAbs, targetAbs);
                break;
            }
            case "mode-changed":
                chmodSync(targetAbs, modeToOctal(patch.mode));
                break;
            case "add":
            case "modify": {
                rmSync(targetAbs, { force: true });
                const sourceAbs = join(sourceSpec.occurrencePath, patch.path);
                if (patch.mode === "120000") {
                    symlinkSync(readlinkSync(sourceAbs), targetAbs);
                } else {
                    writeFileSync(targetAbs, readFileSync(sourceAbs));
                    chmodSync(targetAbs, modeToOctal(patch.mode));
                }
                break;
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `syncOccurrences: failed applying "${patch.kind}" for path "${patch.path}" ` +
                `from source "${sourceSpec.occurrencePath}" to target "${targetSpec.occurrencePath}": ${message}`,
        );
    }
}

function validate(
    sourceOccurrencePath: string,
    occurrences: OccurrenceTreeSpec[],
    maxIterations: number | undefined,
): number {
    if (occurrences.length === 0) throw new Error("syncOccurrences: occurrences must be non-empty");

    const normalized = occurrences.map((o) => ({ ...o, key: resolve(o.occurrencePath) }));
    if (new Set(normalized.map((n) => n.key)).size !== normalized.length) {
        throw new Error("syncOccurrences: duplicate occurrence paths");
    }

    const sourceKey = resolve(sourceOccurrencePath);
    const sourceMatches = normalized.filter((n) => n.key === sourceKey);
    if (sourceMatches.length !== 1) {
        throw new Error(
            `syncOccurrences: expected exactly one occurrence matching source "${sourceOccurrencePath}", found ${sourceMatches.length}`,
        );
    }

    const resolvedMaxIterations = maxIterations ?? 10;
    if (!Number.isInteger(resolvedMaxIterations) || resolvedMaxIterations <= 0) {
        throw new Error(`syncOccurrences: maxIterations must be a positive integer, got ${maxIterations}`);
    }
    return resolvedMaxIterations;
}

export async function syncOccurrences(
    sourceOccurrencePath: string,
    occurrences: OccurrenceTreeSpec[],
    opts?: { maxIterations?: number },
): Promise<SyncResult> {
    const maxIterations = validate(sourceOccurrencePath, occurrences, opts?.maxIterations);

    const sorted = [...occurrences].sort((a, b) => resolve(a.occurrencePath).localeCompare(resolve(b.occurrencePath)));
    const sourceKey = resolve(sourceOccurrencePath);
    const source = sorted.find((o) => resolve(o.occurrencePath) === sourceKey)!;
    const changedPaths = new Map<string, Set<string>>(sorted.map((o) => [resolve(o.occurrencePath), new Set<string>()]));

    let iterations = 0;
    let digests = await Promise.all(sorted.map((o) => computeTreeDigest(o)));

    while (new Set(digests).size !== 1) {
        if (iterations >= maxIterations) {
            return { converged: false, iterations, changedPaths: toSortedArrays(changedPaths) };
        }
        for (const target of sorted) {
            if (resolve(target.occurrencePath) === sourceKey) continue;
            const patches = await computeTreeDelta(source, target);
            const key = resolve(target.occurrencePath);
            for (const patch of patches) {
                applyTreePatch(source, target, patch);
                changedPaths.get(key)!.add(patch.path);
                if (patch.oldPath) changedPaths.get(key)!.add(patch.oldPath);
            }
        }
        iterations += 1;
        digests = await Promise.all(sorted.map((o) => computeTreeDigest(o)));
    }

    return { converged: true, iterations, changedPaths: toSortedArrays(changedPaths) };
}

function toSortedArrays(changedPaths: Map<string, Set<string>>): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [key, paths] of changedPaths) {
        result[key] = [...paths].sort((a, b) => a.localeCompare(b));
    }
    return result;
}
