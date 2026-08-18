// Breadth-first mutation search against traceTaskPipeline: mutate BASE decisions, keep new traces as trimmed fixtures.  Run: node scripts/generatePipelinePaths.ts
import { writeFileSync } from "node:fs";
import { traceTaskPipeline, PATHS_FILE } from "./tracePipeline.ts";
import type { PipelineDecisions, AgentBoxName } from "./tracePipeline.ts";

const EXPLORE_LEN = 8;
const FIXTURE_CAP = 700;

type ArrayField =
    | "plannerOutcome"
    | "planVerdict"
    | "taskTestsPass"
    | "testsFlagged"
    | "lockAcquired"
    | "rebaseConflicts"
    | "rebaseFinished"
    | "suitePasses"
    | "publicationState";

const ARRAY_FIELDS: ArrayField[] = [
    "plannerOutcome",
    "planVerdict",
    "taskTestsPass",
    "testsFlagged",
    "lockAcquired",
    "rebaseConflicts",
    "rebaseFinished",
    "suitePasses",
    "publicationState",
];

const DOMAINS: Record<ArrayField, readonly unknown[]> = {
    plannerOutcome: ["PLAN", "CLARIFY", "ERROR"],
    planVerdict: ["ACCEPT", "AMEND_THEN_ACCEPT", "AMEND", "SCRAP", "ERROR"],
    taskTestsPass: [true, false],
    testsFlagged: [true, false],
    lockAcquired: [true, false],
    rebaseConflicts: [true, false],
    rebaseFinished: [true, false],
    suitePasses: [true, false],
    publicationState: ["ALL LANDED", "NONE LANDED", "SOME LANDED"],
};

const AGENT_BOXES: AgentBoxName[] = ["PLANNER", "PLAN_REVIEWER", "IMPLEMENTER", "TEST_RUNNER", "TEST_REVIEWER", "REBASER", "CONFLICT_FIXER", "REBASE_ADVANCER", "SUITE_RUNNER", "SUITE_FIXER"];

const EXIT_TYPES = [
    "AGENT-FAILED",
    "CLARIFY-STUCK",
    "PLAN-SCRAPPED",
    "TESTS-RED",
    "TESTS-FLAGGED",
    "RUN-FAILED",
    "REBASE-STUCK",
    "SUITE-RED",
    "FENCE-VIOLATION",
    "PARTIALLY-PUBLISHED",
    "MERGE-FAILED",
];

const BASE: PipelineDecisions = {
    taskNumber: 42,
    plannerOutcome: ["PLAN"],
    planVerdict: ["ACCEPT"],
    taskTestsPass: [true],
    testsFlagged: [false],
    lockAcquired: [true],
    rebaseConflicts: [false],
    rebaseFinished: [true],
    suitePasses: [true],
    fenceHeld: true,
    publicationState: ["ALL LANDED"],
};

function pad<T>(arr: T[], len: number): T[] {
    const out = arr.slice();
    while (out.length < len) out.push(out[out.length - 1] as T);
    return out;
}

// Wraps a padded array so `get` on a numeric index records the highest index actually read.
function trackingProxy<T>(arr: T[], record: (index: number) => void): T[] {
    return new Proxy(arr, {
        get(target, prop, receiver) {
            if (typeof prop === "string" && /^\d+$/.test(prop)) record(Number(prop));
            return Reflect.get(target, prop, receiver);
        },
    });
}

function instrument(candidate: PipelineDecisions): { padded: PipelineDecisions; maxRead: Map<string, number> } {
    const maxRead = new Map<string, number>();
    const record = (key: string) => (index: number): void => {
        if (index > (maxRead.get(key) ?? -1)) maxRead.set(key, index);
    };

    const padded = { taskNumber: candidate.taskNumber, fenceHeld: candidate.fenceHeld } as PipelineDecisions;
    for (const field of ARRAY_FIELDS) {
        (padded as Record<ArrayField, unknown>)[field] = trackingProxy(pad(candidate[field] as unknown[], EXPLORE_LEN), record(field));
    }
    const agentErrors: Partial<Record<AgentBoxName, boolean[]>> = {};
    for (const box of AGENT_BOXES) {
        const source = candidate.agentErrors?.[box] ?? [false];
        agentErrors[box] = trackingProxy(pad(source, EXPLORE_LEN), record(`agentErrors.${box}`));
    }
    padded.agentErrors = agentErrors;
    return { padded, maxRead };
}

// Keeps entries 0..maxIdx, then collapses a run of trailing duplicates down to one entry.
function trimArray<T>(arr: T[], maxIdx: number): T[] {
    const len = Math.max(maxIdx + 1, 1);
    const out: T[] = [];
    for (let i = 0; i < len; i += 1) out.push(arr[Math.min(i, arr.length - 1)] as T);
    while (out.length > 1 && out[out.length - 1] === out[out.length - 2]) out.pop();
    return out;
}

function trimCandidate(candidate: PipelineDecisions, maxRead: Map<string, number>): PipelineDecisions {
    const trimmed = { taskNumber: candidate.taskNumber, fenceHeld: candidate.fenceHeld } as PipelineDecisions;
    for (const field of ARRAY_FIELDS) {
        const maxIdx = maxRead.get(field) ?? -1;
        (trimmed as Record<ArrayField, unknown>)[field] = trimArray(candidate[field] as unknown[], maxIdx);
    }
    const agentErrors: Partial<Record<AgentBoxName, boolean[]>> = {};
    for (const box of AGENT_BOXES) {
        const maxIdx = maxRead.get(`agentErrors.${box}`) ?? -1;
        if (maxIdx < 0) continue;
        agentErrors[box] = trimArray(candidate.agentErrors?.[box] ?? [false], maxIdx);
    }
    if (Object.keys(agentErrors).length > 0) trimmed.agentErrors = agentErrors;
    return trimmed;
}

function cloneWithField(candidate: PipelineDecisions, field: ArrayField, index: number, value: unknown): PipelineDecisions {
    const clone = JSON.parse(JSON.stringify(candidate)) as PipelineDecisions;
    const arr = pad((clone as Record<ArrayField, unknown[]>)[field], index + 1);
    arr[index] = value;
    (clone as Record<ArrayField, unknown[]>)[field] = arr;
    return clone;
}

function cloneWithAgentError(candidate: PipelineDecisions, box: AgentBoxName, index: number): PipelineDecisions {
    const clone = JSON.parse(JSON.stringify(candidate)) as PipelineDecisions;
    clone.agentErrors ??= {};
    const arr = pad(clone.agentErrors[box] ?? [false], index + 1);
    arr[index] = true;
    clone.agentErrors[box] = arr;
    return clone;
}

function* children(candidate: PipelineDecisions, maxRead: Map<string, number>): Generator<PipelineDecisions> {
    for (const field of ARRAY_FIELDS) {
        const maxIdx = maxRead.get(field) ?? -1;
        const arr = candidate[field] as unknown[];
        for (let i = 0; i <= maxIdx; i += 1) {
            const current = arr[Math.min(i, arr.length - 1)];
            for (const value of DOMAINS[field]) {
                if (value === current) continue;
                yield cloneWithField(candidate, field, i, value);
            }
        }
    }

    yield { ...candidate, fenceHeld: !candidate.fenceHeld };

    for (const box of AGENT_BOXES) {
        const maxIdx = maxRead.get(`agentErrors.${box}`) ?? -1;
        const source = candidate.agentErrors?.[box] ?? [false];
        for (let i = 0; i <= maxIdx; i += 1) {
            if (source[Math.min(i, source.length - 1)] === true) continue;
            yield cloneWithAgentError(candidate, box, i);
        }
    }
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function exitTypeOf(trace: string[]): string {
    for (const line of trace) {
        for (const exitType of EXIT_TYPES) {
            if (line.endsWith(`: ${exitType}`)) return exitType;
        }
    }
    return "completed";
}

const fieldSlug = (field: string): string => field.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`);

const valueSlug = (v: unknown): string => (typeof v === "boolean" ? String(v) : String(v).toLowerCase().replace(/\s+/g, "-"));

function differenceSlugParts(trimmed: PipelineDecisions): string[] {
    const parts: string[] = [];
    for (const field of ARRAY_FIELDS) {
        const baseVal = (BASE[field] as unknown[])[0];
        (trimmed[field] as unknown[]).forEach((v, i) => {
            if (v !== baseVal) parts.push(`${fieldSlug(field)}${i}-${valueSlug(v)}`);
        });
    }
    if (trimmed.fenceHeld !== BASE.fenceHeld) parts.push(`fence-held-${trimmed.fenceHeld}`);
    if (trimmed.agentErrors) {
        for (const box of AGENT_BOXES) {
            const arr = trimmed.agentErrors[box];
            if (!arr) continue;
            arr.forEach((v, i) => {
                if (v) parts.push(`${box.toLowerCase().replace(/_/g, "-")}-err${i}`);
            });
        }
    }
    return parts;
}

function nameFor(trimmed: PipelineDecisions, trace: string[], usedNames: Set<string>): string {
    const base = exitTypeOf(trace) === "completed" ? "completed" : exitTypeOf(trace).toLowerCase();
    const parts = differenceSlugParts(trimmed);
    const stem = parts.length > 0 ? `${base}--${parts.join("-")}` : base;
    let name = stem;
    let suffix = 2;
    while (usedNames.has(name)) {
        name = `${stem}-${suffix}`;
        suffix += 1;
    }
    return name;
}

function main(): void {
    const queue: PipelineDecisions[] = [BASE];
    const queuedCanon = new Set<string>([stableStringify(BASE)]);
    const seenTraceKeys = new Set<string>();
    const usedNames = new Set<string>();
    const fixtures: Record<string, PipelineDecisions> = {};
    let candidatesEvaluated = 0;
    let cappedWithQueued = 0;

    while (queue.length > 0) {
        if (Object.keys(fixtures).length >= FIXTURE_CAP) {
            cappedWithQueued = queue.length;
            break;
        }
        const candidate = queue.shift() as PipelineDecisions;
        candidatesEvaluated += 1;

        const { padded, maxRead } = instrument(candidate);
        const trace = traceTaskPipeline(padded);
        const traceKey = trace.join("\n");

        if (!seenTraceKeys.has(traceKey)) {
            seenTraceKeys.add(traceKey);
            const trimmed = trimCandidate(candidate, maxRead);
            const verifyKey = traceTaskPipeline(trimmed).join("\n");
            if (verifyKey !== traceKey) {
                throw new Error(`trimmed candidate diverged from the original trace it was trimmed from`);
            }
            const name = nameFor(trimmed, trace, usedNames);
            usedNames.add(name);
            fixtures[name] = trimmed;
        }

        for (const child of children(candidate, maxRead)) {
            const key = stableStringify(child);
            if (queuedCanon.has(key)) continue;
            queuedCanon.add(key);
            queue.push(child);
        }
    }

    const sortedNames = Object.keys(fixtures).sort();
    const out: Record<string, PipelineDecisions> = {};
    for (const name of sortedNames) out[name] = fixtures[name] as PipelineDecisions;
    writeFileSync(PATHS_FILE, `${JSON.stringify(out, null, 4)}\n`);

    process.stderr.write(`candidates evaluated: ${candidatesEvaluated}\n`);
    process.stderr.write(`fixtures written: ${sortedNames.length}\n`);
    if (cappedWithQueued > 0) {
        process.stderr.write(`fixture cap of ${FIXTURE_CAP} hit; ${cappedWithQueued} candidates still queued and not explored\n`);
    }
}

main();
