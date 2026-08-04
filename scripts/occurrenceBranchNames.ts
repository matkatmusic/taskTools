// Assigns each occurrence of a logical repository a valid, deterministic git branch name.
import { createHash } from "node:crypto";

// ponytail: 40-bit truncation (10 hex chars) of a sha256 digest — plenty for realistic occurrence counts per logical repository; widen HASH_LENGTH if collisions are ever observed.
const HASH_LENGTH = 10;

function sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^A-Za-z0-9_-]/g, "-");
    return cleaned === "" ? "seg" : cleaned;
}

function sanitizeOccurrencePath(occurrencePath: string): string {
    return occurrencePath.split("/").map(sanitizeSegment).join("/");
}

function collisionHash(occurrencePath: string): string {
    return createHash("sha256").update(occurrencePath).digest("hex").slice(0, HASH_LENGTH);
}

export function occurrenceBranchNames(
    groupBranchName: string,
    occurrencePaths: string[],
): Map<string, string> {
    const names = new Map<string, string>();
    if (occurrencePaths.length <= 1) {
        for (const path of occurrencePaths) names.set(path, groupBranchName);
        return names;
    }
    for (const path of occurrencePaths) {
        const sanitizedPath = sanitizeOccurrencePath(path);
        names.set(path, `${groupBranchName}/${sanitizedPath}-${collisionHash(path)}`);
    }
    return names;
}
