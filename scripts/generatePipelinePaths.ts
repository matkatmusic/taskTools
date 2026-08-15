// Derives scripts/tracePipelinePaths.json fixtures directly from the four decision-bearing
// sub-pipeline diagrams (preamble, planning, implement-and-test, rebase-and-merge), instead of
// searching PipelineDecisions' combinatorial space.
//
// mmdGraph.ts's enumeratePaths already runs the DFS that finds every terminating walk through a
// diagram (maxEdgeUses=2, matching MAX_ATTEMPTS=2). This script treats that walk list as the
// INPUT: for each diagram, for each enumerated node-id path, it inverts the path into the
// PipelineDecisions fragment that would make traceTaskPipeline walk exactly those boxes, then
// composes that fragment with "boring" (everything-succeeds) fragments for the other three
// phases to get one complete end-to-end decisions object per path. Dedupe by resulting trace.
//
// Every YES/NO/verdict node in a path is either:
//   - a genuine decision the tracer reads from PipelineDecisions (recorded into a fragment field)
//   - a derived "first time?" / "N rounds done?" gate computed from an attempt counter, not
//     supplied by any field. Its value is forced by the counter, so it is *validated* against
//     what the counter implies rather than recorded. A path that disagrees with the counter is
//     not producible by any decisions object - see reportUnrealizable().
//
// Run: node scripts/generatePipelinePaths.ts
// Deterministic: no Math.random, no Date.now. Re-running reproduces the file byte-for-byte.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMmd, enumeratePaths, type MmdGraph } from "./mmdGraph.ts";
import { traceTaskPipeline, readNamedPaths, PATHS_FILE, type PipelineDecisions, type ReceiptName } from "./tracePipeline.ts";

const DIAGRAM_DIR = fileURLToPath(new URL("../plans/diagram/", import.meta.url));
const MAX_ATTEMPTS = 2;

const isMarker = (id: string): boolean =>
    id.endsWith("_YES") || id.endsWith("_NO") || id === "VERDICT_SCRAP" || id === "VERDICT_AMEND" || id === "VERDICT_ACCEPT";

function loadGraph(file: string): MmdGraph {
    return parseMmd(readFileSync(DIAGRAM_DIR + file, "utf8"));
}

// A cursor over one path's marker tokens, shared shape for all four interpreters.
class Markers {
    private i = 0;
    private readonly tokens: string[];
    constructor(tokens: string[]) {
        this.tokens = tokens;
    }
    next(): string {
        if (this.i >= this.tokens.length) throw new Error(`marker stream exhausted at index ${this.i} of ${this.tokens.join(",")}`);
        return this.tokens[this.i++]!;
    }
    atEnd(): boolean {
        return this.i === this.tokens.length;
    }
}

type Fragment = { ok: true; fields: Partial<PipelineDecisions>; terminal: boolean; events: string[] } | { ok: false; reason: string };

const yes = (m: string): boolean => m.endsWith("_YES");

// Validates a derived "first time?" style gate against the counter that actually governs it.
// firstBranch/secondBranch are "YES"|"NO": what the marker must be on the 1st vs 2nd visit.
function gate(m: Markers, attempt: number, firstBranch: "YES" | "NO", secondBranch: "YES" | "NO"): { ok: true; isSecond: boolean } | { ok: false; reason: string } {
    const marker = m.next();
    const got = yes(marker) ? "YES" : "NO";
    const expected = attempt < MAX_ATTEMPTS ? firstBranch : secondBranch;
    if (got !== expected) {
        return { ok: false, reason: `derived gate ${marker} disagrees with its attempt counter (attempt ${attempt}, expected ${expected})` };
    }
    return { ok: true, isSecond: attempt >= MAX_ATTEMPTS };
}

// ---------------------------------------------------------------------------------------------
// PREAMBLE: mirrors traceTaskPipeline lines ~240-278. No derived gates in this diagram.
function interpretPreamble(markers: Markers): Fragment {
    const fields: Partial<PipelineDecisions> = {};
    const events: string[] = [];

    const taskNumberValid = yes(markers.next());
    fields.taskNumberValid = taskNumberValid;
    if (!taskNumberValid) return { ok: true, fields, terminal: true, events: ["invalid-number"] };

    const taskOpen = yes(markers.next());
    fields.taskOpen = taskOpen;
    if (!taskOpen) return { ok: true, fields, terminal: true, events: ["not-open"] };

    const taskActive = yes(markers.next());
    fields.taskActive = taskActive;
    if (taskActive) return { ok: true, fields, terminal: true, events: ["already-active"] };

    const taskBlocked = yes(markers.next());
    fields.taskBlocked = taskBlocked;
    if (taskBlocked) return { ok: true, fields, terminal: true, events: ["blocked"] };

    const worktreeExists = yes(markers.next());
    fields.worktreeExists = worktreeExists;
    if (!worktreeExists) {
        events.push("new-worktree");
    } else {
        const worktreeSafe = yes(markers.next());
        fields.worktreeSafe = worktreeSafe;
        if (worktreeSafe) {
            events.push("safe-worktree");
        } else {
            const previousWorkResumable = yes(markers.next());
            fields.previousWorkResumable = previousWorkResumable;
            events.push(previousWorkResumable ? "resumable-worktree" : "unresumable-worktree");
        }
    }

    const receiptValid = yes(markers.next());
    if (!receiptValid) {
        fields.malformedReceipt = "active task";
        events.push("malformed-active-task-receipt");
        return { ok: true, fields, terminal: true, events };
    }
    return { ok: true, fields, terminal: false, events };
}

// ---------------------------------------------------------------------------------------------
// PLANNING: mirrors traceTaskPipeline lines ~287-325.
function interpretPlanning(markers: Markers): Fragment {
    const verdicts: ("accept" | "amend" | "scrap")[] = [];
    const events: string[] = [];
    let scrapAttempt = 0;
    let amendRound = 0;

    for (;;) {
        const planFileValid = yes(markers.next());
        if (!planFileValid) {
            return { ok: true, fields: { codexPlanVerdict: verdicts.length ? verdicts : ["accept"], malformedReceipt: "plan file" }, terminal: true, events: [...events, "malformed-plan-file-receipt"] };
        }

        for (;;) {
            const reviewValid = yes(markers.next());
            if (!reviewValid) {
                // receipt() only fails equality by name, always on the FIRST call to that
                // receipt - a malformed codex review after a verdict already landed is not
                // producible by any decisions object.
                if (verdicts.length > 0) return { ok: false, reason: "malformed codex-review receipt appears after an earlier verdict; malformedReceipt only fails the first call" };
                return { ok: true, fields: { codexPlanVerdict: ["accept"], malformedReceipt: "codex review" }, terminal: true, events: [...events, "malformed-codex-review-receipt"] };
            }

            const verdictMarker = markers.next();
            const verdict = verdictMarker === "VERDICT_SCRAP" ? "scrap" : verdictMarker === "VERDICT_AMEND" ? "amend" : "accept";
            verdicts.push(verdict);
            events.push(`verdict-${verdict}`);

            if (verdict === "accept") {
                return finishPlanning(markers, verdicts, events);
            }
            if (verdict === "scrap") {
                scrapAttempt += 1;
                const g = gate(markers, scrapAttempt, "YES", "NO");
                if (!g.ok) return g;
                if (g.isSecond) {
                    events.push("plan-scrapped");
                    return { ok: true, fields: { codexPlanVerdict: verdicts }, terminal: true, events };
                }
                break; // re-enter outer loop: re-plan
            }
            // amend
            amendRound += 1;
            const g = gate(markers, amendRound, "NO", "YES");
            if (!g.ok) return g;
            if (g.isSecond) {
                return finishPlanning(markers, verdicts, events);
            }
            // else: continue inner loop, re-review without re-planning
        }
    }
}

function finishPlanning(markers: Markers, verdicts: ("accept" | "amend" | "scrap")[], events: string[]): Fragment {
    const receiptValid = yes(markers.next());
    if (!receiptValid) {
        return { ok: true, fields: { codexPlanVerdict: verdicts, malformedReceipt: "finished plan" }, terminal: true, events: [...events, "malformed-finished-plan-receipt"] };
    }
    return { ok: true, fields: { codexPlanVerdict: verdicts }, terminal: false, events };
}

// ---------------------------------------------------------------------------------------------
// IMPLEMENT AND TEST: mirrors traceTaskPipeline lines ~335-414.
function interpretImplementTest(markers: Markers): Fragment {
    const taskTestsFail: boolean[] = [];
    const codexTestsFlagged: boolean[] = [];
    const sourceRepoFree: boolean[] = [];
    const lockSucceeds: boolean[] = [];
    const events: string[] = [];
    let testAttempt = 0;
    let codexTestAttempt = 0;
    let heldAttempt = 0;
    let lockFailAttempt = 0;

    for (;;) {
        const fails = yes(markers.next());
        taskTestsFail.push(fails);
        if (fails) {
            events.push("tests-fail");
            testAttempt += 1;
            const g = gate(markers, testAttempt, "YES", "NO");
            if (!g.ok) return g;
            if (g.isSecond) {
                events.push("tests-red");
                return { ok: true, fields: { taskTestsFail, codexTestsFlagged, sourceRepoFree, lockSucceeds }, terminal: true, events };
            }
            const fixValid = yes(markers.next());
            if (!fixValid) {
                return { ok: true, fields: { taskTestsFail, codexTestsFlagged, sourceRepoFree, lockSucceeds, malformedReceipt: "fix the codebase" }, terminal: true, events: [...events, "malformed-fix-the-codebase-receipt"] };
            }
            continue;
        }

        const testReviewValid = yes(markers.next());
        if (!testReviewValid) {
            return { ok: true, fields: { taskTestsFail, codexTestsFlagged, sourceRepoFree, lockSucceeds, malformedReceipt: "test review" }, terminal: true, events: [...events, "malformed-test-review-receipt"] };
        }
        const flagged = yes(markers.next());
        codexTestsFlagged.push(flagged);
        if (!flagged) break;
        events.push("tests-flagged");
        codexTestAttempt += 1;
        const g = gate(markers, codexTestAttempt, "YES", "NO");
        if (!g.ok) return g;
        if (g.isSecond) {
            events.push("tests-flagged-twice");
            return { ok: true, fields: { taskTestsFail, codexTestsFlagged, sourceRepoFree, lockSucceeds }, terminal: true, events };
        }
        const amendValid = yes(markers.next());
        if (!amendValid) {
            return { ok: true, fields: { taskTestsFail, codexTestsFlagged, sourceRepoFree, lockSucceeds, malformedReceipt: "amend tests" }, terminal: true, events: [...events, "malformed-amend-tests-receipt"] };
        }
    }

    for (;;) {
        const free = yes(markers.next());
        sourceRepoFree.push(free);
        if (!free) {
            events.push("source-repo-held");
            heldAttempt += 1;
            const g = gate(markers, heldAttempt, "YES", "NO");
            if (!g.ok) return g;
            if (g.isSecond) {
                events.push("source-repo-held-twice");
                return { ok: true, fields: { taskTestsFail, codexTestsFlagged, sourceRepoFree, lockSucceeds }, terminal: true, events };
            }
            continue;
        }
        const locked = yes(markers.next());
        lockSucceeds.push(locked);
        if (locked) break;
        events.push("lock-race-lost");
        lockFailAttempt += 1;
        const g = gate(markers, lockFailAttempt, "YES", "NO");
        if (!g.ok) return g;
        if (g.isSecond) {
            events.push("lock-race-lost-twice");
            return { ok: true, fields: { taskTestsFail, codexTestsFlagged, sourceRepoFree, lockSucceeds }, terminal: true, events };
        }
    }

    const implReceiptValid = yes(markers.next());
    if (!implReceiptValid) {
        return { ok: true, fields: { taskTestsFail, codexTestsFlagged, sourceRepoFree, lockSucceeds, malformedReceipt: "finished implementation" }, terminal: true, events: [...events, "malformed-finished-implementation-receipt"] };
    }
    return { ok: true, fields: { taskTestsFail, codexTestsFlagged, sourceRepoFree, lockSucceeds }, terminal: false, events };
}

// ---------------------------------------------------------------------------------------------
// REBASE AND MERGE: mirrors traceTaskPipeline lines ~424-493.
function interpretRebaseMerge(markers: Markers): Fragment {
    const rebase: ("ok" | "conflict")[] = [];
    const rebaseAdvance: ("finished" | "conflicts")[] = [];
    const fullSuitePasses: boolean[] = [];
    const mergeLands: boolean[] = [];
    const events: string[] = [];
    let conflictAttempt = 0;
    let suiteAttempt = 0;
    let mergeAttempt = 0;
    let fenceHeld = true;

    const done = (extra: Partial<PipelineDecisions> = {}): Fragment => ({
        ok: true,
        fields: { rebase, rebaseAdvance, fullSuitePasses, fenceHeld, mergeLands, ...extra },
        terminal: true,
        events,
    });

    outer: for (;;) {
        let conflicted = yes(markers.next());
        rebase.push(conflicted ? "conflict" : "ok");

        for (;;) {
            if (conflicted) {
                events.push("rebase-conflict");
                conflictAttempt += 1;
                const g = gate(markers, conflictAttempt, "YES", "NO");
                if (!g.ok) return g;
                if (g.isSecond) {
                    events.push("rebase-stuck");
                    return done();
                }
                const conflictFixValid = yes(markers.next());
                if (!conflictFixValid) {
                    events.push("malformed-conflict-fix-receipt");
                    return done({ malformedReceipt: "conflict fix" });
                }
            }
            const finished = yes(markers.next());
            rebaseAdvance.push(finished ? "finished" : "conflicts");
            if (finished) {
                const suitePasses = yes(markers.next());
                fullSuitePasses.push(suitePasses);
                if (suitePasses) break;
                events.push("suite-fail");
                suiteAttempt += 1;
                const g = gate(markers, suiteAttempt, "YES", "NO");
                if (!g.ok) return g;
                if (g.isSecond) {
                    events.push("suite-red");
                    return done();
                }
                const suiteFixValid = yes(markers.next());
                if (!suiteFixValid) {
                    events.push("malformed-fix-the-full-suite-receipt");
                    return done({ malformedReceipt: "fix the full suite" });
                }
                conflicted = false;
                continue;
            }
            events.push("advance-uncovers-conflicts");
            conflicted = yes(markers.next());
            rebase.push(conflicted ? "conflict" : "ok");
        }

        fenceHeld = yes(markers.next());
        if (!fenceHeld) {
            events.push("fence-violation");
            return done();
        }
        const merged = yes(markers.next());
        mergeLands.push(merged);
        if (merged) break outer;
        events.push("merge-fail");
        mergeAttempt += 1;
        const g = gate(markers, mergeAttempt, "YES", "NO");
        if (!g.ok) return g;
        if (g.isSecond) {
            events.push("merge-failed");
            return done();
        }
        conflictAttempt = 0;
        suiteAttempt = 0;
    }

    const mergeReceiptValid = yes(markers.next());
    if (!mergeReceiptValid) {
        events.push("malformed-merge-receipt");
        return done({ malformedReceipt: "merge" });
    }
    return { ok: true, fields: { rebase, rebaseAdvance, fullSuitePasses, fenceHeld, mergeLands }, terminal: false, events };
}

// ---------------------------------------------------------------------------------------------
type PhaseName = "preamble" | "planning" | "implementTest" | "rebaseMerge";

const PHASES: { name: PhaseName; file: string; interpret: (m: Markers) => Fragment }[] = [
    { name: "preamble", file: "pipeline-preamble.mmd", interpret: interpretPreamble },
    { name: "planning", file: "pipeline-planning.mmd", interpret: interpretPlanning },
    { name: "implementTest", file: "pipeline-implementTest.mmd", interpret: interpretImplementTest },
    { name: "rebaseMerge", file: "pipeline-rebaseMerge.mmd", interpret: interpretRebaseMerge },
];

const BASE: PipelineDecisions = {
    taskNumber: 42,
    taskNumberValid: true,
    taskOpen: true,
    taskActive: false,
    taskBlocked: false,
    worktreeExists: false,
    worktreeSafe: true,
    previousWorkResumable: true,
    codexPlanVerdict: ["accept"],
    taskTestsFail: [false],
    codexTestsFlagged: [false],
    sourceRepoFree: [true],
    lockSucceeds: [true],
    rebase: ["ok"],
    rebaseAdvance: ["finished"],
    fullSuitePasses: [true],
    fenceHeld: true,
    mergeLands: [true],
};

type PathResult = { path: string[]; markers: string[] } & (
    | { ok: true; fields: Partial<PipelineDecisions>; terminal: boolean; events: string[] }
    | { ok: false; reason: string }
);

function runLength(labels: string[]): string {
    if (labels.length === 0) return "clean";
    const groups: string[] = [];
    let i = 0;
    while (i < labels.length) {
        let j = i;
        while (j < labels.length && labels[j] === labels[i]) j += 1;
        const count = j - i;
        groups.push(count >= 2 ? `${labels[i]}-twice` : labels[i]!);
        i = j;
    }
    return groups.join("-then-");
}

function nameFor(phase: PhaseName, events: string[]): string {
    const notable = events.filter((e) => e !== "clean");
    const slug = runLength(notable);
    return `${phase.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`)}--${slug}`;
}

function main(): void {
    const originals = readNamedPaths();
    const originalNames = Object.keys(originals);
    const traceKey = (d: PipelineDecisions): string => traceTaskPipeline(d).join("\n");

    const traceToName = new Map<string, string>();
    for (const name of originalNames) traceToName.set(traceKey(originals[name]!), name);

    const unrealizable: { phase: PhaseName; path: string[]; reason: string }[] = [];
    const pathCoverage = new Map<PhaseName, Map<string, string>>(); // enumerated-path-key -> covering fixture name

    const generated: Record<string, PipelineDecisions> = {};
    const usedNames = new Set<string>(originalNames);

    for (const phase of PHASES) {
        const graph = loadGraph(phase.file);
        const enumerated = enumeratePaths(graph, 2);
        const coverage = new Map<string, string>();
        pathCoverage.set(phase.name, coverage);

        for (const path of enumerated) {
            const markerTokens = path.filter(isMarker);
            const markers = new Markers(markerTokens);
            const pathKey = path.join(">");
            let result: ReturnType<typeof interpretPreamble>;
            try {
                result = phase.interpret(markers);
            } catch (err) {
                result = { ok: false, reason: `interpreter crashed: ${(err as Error).message}` };
            }
            if (!result.ok) {
                unrealizable.push({ phase: phase.name, path, reason: result.reason });
                continue;
            }
            if (!markers.atEnd()) {
                unrealizable.push({ phase: phase.name, path, reason: "interpreter finished before consuming every marker on the path" });
                continue;
            }

            const decisions: PipelineDecisions = { ...BASE, ...result.fields };
            if (!("malformedReceipt" in result.fields)) delete decisions.malformedReceipt;
            const key = traceKey(decisions);

            const existingName = traceToName.get(key);
            if (existingName) {
                coverage.set(pathKey, existingName);
                continue;
            }

            let name = nameFor(phase.name, result.events);
            let suffix = 2;
            while (usedNames.has(name)) {
                name = `${nameFor(phase.name, result.events)}-${suffix}`;
                suffix += 1;
            }
            usedNames.add(name);
            traceToName.set(key, name);
            generated[name] = decisions;
            coverage.set(pathKey, name);
        }
    }

    const merged: Record<string, PipelineDecisions> = { ...originals, ...generated };
    writeFileSync(PATHS_FILE, `${JSON.stringify(merged, null, 4)}\n`);

    process.stderr.write(`originals: ${originalNames.length}\n`);
    process.stderr.write(`generated: ${Object.keys(generated).length}\n`);
    process.stderr.write(`total: ${Object.keys(merged).length}\n`);
    for (const phase of PHASES) {
        const coverage = pathCoverage.get(phase.name)!;
        const graph = loadGraph(phase.file);
        const total = enumeratePaths(graph, 2).length;
        const unreach = unrealizable.filter((u) => u.phase === phase.name);
        process.stderr.write(`${phase.name}: ${coverage.size}/${total} enumerated paths reached, ${unreach.length} unrealizable\n`);
    }
    if (unrealizable.length > 0) {
        process.stderr.write(`\nunrealizable paths:\n`);
        for (const u of unrealizable) {
            process.stderr.write(`  [${u.phase}] ${u.reason}\n    ${u.path.join(" -> ")}\n`);
        }
    }
}

main();
