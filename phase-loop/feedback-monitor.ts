import { execFileSync } from "node:child_process";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type FeedbackMonitorOptions = {
    projectRoot: string;
    pollIntervalMs?: number;
    timeoutMs?: number | null;
};

export type ReviewedMonitorEvent = {
    event: "reviewed";
    markerPath: string;
    planPath: string;
    auditPath: string;
    reviewPath: string;
    relativePlanPath: string;
    relativeAuditPath: string;
    relativeReviewPath: string;
};

export type ResolvedMonitorEvent = {
    event: "resolved";
    markerPath: string;
};

export type ImplementorMonitorEvent = ReviewedMonitorEvent | ResolvedMonitorEvent;

export type ReviewedMarker = {
    plan: string;
    audit: string;
    review: string;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const REVIEWED_MARKER_KEYS = new Set([".plan", ".audit", ".review"]);

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function assertPositiveMilliseconds(value: number, label: string): void {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
}

function repositoryRoot(projectRoot: string): string {
    return execFileSync("git", ["-C", resolve(projectRoot), "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
    }).trim();
}

function statPathIsFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function refuseTrackedMarker(root: string): void {
    const markerPath = join(root, ".reviewed");
    try {
        execFileSync("git", ["-C", root, "cat-file", "-e", "HEAD:.reviewed"], { stdio: "ignore" });
        throw new Error(`refusing to consume tracked repository file as a marker: ${markerPath}`);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("refusing to consume")) throw error;
    }
}

/** Parse a complete auditor publication marker. Each key must occur exactly once. */
export function parseReviewedMarker(contents: string): ReviewedMarker {
    const fields = new Map<string, string>();
    for (const line of contents.split(/\r?\n/)) {
        if (line.length === 0) continue;
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`invalid .reviewed line: ${line}`);
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (!REVIEWED_MARKER_KEYS.has(key)) throw new Error(`unknown .reviewed key: ${key}`);
        if (fields.has(key)) throw new Error(`duplicate .reviewed key: ${key}`);
        if (value.length === 0) throw new Error(`empty .reviewed value for ${key}`);
        fields.set(key, value);
    }
    for (const key of REVIEWED_MARKER_KEYS) {
        if (!fields.has(key)) throw new Error(`missing .reviewed key: ${key}`);
    }
    return {
        plan: fields.get(".plan")!,
        audit: fields.get(".audit")!,
        review: fields.get(".review")!,
    };
}

function resolvePublishedPath(root: string, path: string): string {
    return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

/** Read, validate, and consume one complete auditor review publication. */
export function consumeRootReviewedMarker(projectRoot: string): ReviewedMonitorEvent {
    const root = repositoryRoot(projectRoot);
    const markerPath = join(root, ".reviewed");
    if (!statPathIsFile(markerPath)) throw new Error(`the root review marker does not exist: ${markerPath}`);
    refuseTrackedMarker(root);

    const marker = parseReviewedMarker(readFileSync(markerPath, "utf8"));
    const planPath = resolvePublishedPath(root, marker.plan);
    const auditPath = resolvePublishedPath(root, marker.audit);
    const reviewPath = resolvePublishedPath(root, marker.review);
    for (const [label, path] of [["plan", planPath], ["audit", auditPath], ["review", reviewPath]] as const) {
        if (!statPathIsFile(path)) throw new Error(`.reviewed ${label} path is not a file: ${path}`);
    }

    unlinkSync(markerPath);
    return {
        event: "reviewed",
        markerPath,
        planPath,
        auditPath,
        reviewPath,
        relativePlanPath: relative(root, planPath),
        relativeAuditPath: relative(root, auditPath),
        relativeReviewPath: relative(root, reviewPath),
    };
}

/** Wait for a fully published auditor review or the terminal resolution marker. */
export async function waitForImplementorSignal(
    options: FeedbackMonitorOptions,
): Promise<ImplementorMonitorEvent> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? null;
    assertPositiveMilliseconds(pollIntervalMs, "pollIntervalMs");
    if (timeoutMs !== null) assertPositiveMilliseconds(timeoutMs, "timeoutMs");

    const root = repositoryRoot(options.projectRoot);
    const reviewedPath = join(root, ".reviewed");
    const resolvedPath = join(root, ".resolved");
    const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
    while (true) {
        const hasReviewed = statPathIsFile(reviewedPath);
        const hasResolved = statPathIsFile(resolvedPath);
        if (hasReviewed && hasResolved) {
            throw new Error(`conflicting root protocol markers: ${reviewedPath} and ${resolvedPath}`);
        }
        if (hasResolved) return { event: "resolved", markerPath: resolvedPath };
        if (hasReviewed) return consumeRootReviewedMarker(root);
        if (deadline !== null && Date.now() >= deadline) {
            throw new Error(`timed out waiting for root .reviewed or .resolved in ${root}`);
        }
        await sleep(pollIntervalMs);
    }
}

type CliOptions = FeedbackMonitorOptions;

function parseCliOptions(args: string[]): CliOptions {
    let projectRoot = process.cwd();
    let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    let timeoutMs: number | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        const value = args[index + 1];
        if (argument === "--root" && value !== undefined) {
            projectRoot = isAbsolute(value) ? value : resolve(process.cwd(), value);
            index += 1;
        } else if (argument === "--poll-ms" && value !== undefined) {
            pollIntervalMs = Number(value);
            index += 1;
        } else if (argument === "--timeout-ms" && value !== undefined) {
            timeoutMs = Number(value);
            index += 1;
        } else {
            throw new Error(`unknown or incomplete argument: ${argument}`);
        }
    }
    return { projectRoot, pollIntervalMs, timeoutMs };
}

if (process.argv[1]?.endsWith("feedback-monitor.ts")) {
    waitForImplementorSignal(parseCliOptions(process.argv.slice(2)))
        .then((event) => process.stdout.write(`${JSON.stringify(event)}\n`))
        .catch((error) => {
            process.stderr.write(`feedback-monitor: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        });
}
