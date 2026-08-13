// Plan and codex-review file validation, plus the pure amendment-application rule.
// No CLI — see plans/plan-format.md and plans/tackle-tasks-v1_5-plan.md §4.
import { readFileSync } from "node:fs";

export type PlanSection = { id: string; title: string; body: string };
export type Plan = { task: number; revision: number; sections: PlanSection[] };
export type PlanProblem = { problem: string };

export type PlanAmendment =
    | { op: "insert"; after: string; id: string; title: string; body: string }
    | { op: "replace"; id: string; title?: string; body: string }
    | { op: "remove"; id: string };

export type CodexReview =
    | { verdict: "amend"; notes?: string; amendments: PlanAmendment[] }
    | { verdict: "scrap"; notes: string };

export type AmendmentResult =
    | { status: "applied"; plan: Plan }
    | { status: "rejected"; problem: string };

const SECTION_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isPlanProblem(result: Plan | PlanProblem): result is PlanProblem {
    return "problem" in result;
}

export function isReviewProblem(result: CodexReview | PlanProblem): result is PlanProblem {
    return "problem" in result;
}

function parseJsonFile(filePath: string): { value: unknown } | PlanProblem {
    let raw: string;
    try {
        raw = readFileSync(filePath, "utf8");
    } catch {
        return { problem: `cannot read file: ${filePath}` };
    }
    try {
        return { value: JSON.parse(raw) };
    } catch {
        return { problem: `file is not valid JSON: ${filePath}` };
    }
}

export function validatePlanShape(value: unknown, expectedTaskNumber: number): Plan | PlanProblem {
    if (typeof value !== "object" || value === null) return { problem: "plan is not an object" };
    const plan = value as Record<string, unknown>;
    if (plan.task !== expectedTaskNumber) {
        return { problem: `plan task ${JSON.stringify(plan.task)} does not match expected task ${expectedTaskNumber}` };
    }
    if (!Number.isInteger(plan.revision) || (plan.revision as number) < 1) {
        return { problem: "plan revision must be a positive integer" };
    }
    if (!Array.isArray(plan.sections) || plan.sections.length === 0) {
        return { problem: "plan sections must be a non-empty array" };
    }
    const seenIds = new Set<string>();
    for (const section of plan.sections) {
        if (typeof section !== "object" || section === null) return { problem: "plan section is not an object" };
        const { id, title, body } = section as Record<string, unknown>;
        if (typeof id !== "string" || !SECTION_ID_PATTERN.test(id)) {
            return { problem: `plan section id is not valid kebab-case: ${JSON.stringify(id)}` };
        }
        if (seenIds.has(id)) return { problem: `plan has a duplicate section id: ${id}` };
        seenIds.add(id);
        if (typeof title !== "string") return { problem: `plan section "${id}" is missing a string title` };
        if (typeof body !== "string") return { problem: `plan section "${id}" is missing a string body` };
    }
    return { task: plan.task as number, revision: plan.revision as number, sections: plan.sections as PlanSection[] };
}

export function readAndValidatePlan(planFilePath: string, expectedTaskNumber: number): Plan | PlanProblem {
    const parsed = parseJsonFile(planFilePath);
    if ("problem" in parsed) return parsed;
    return validatePlanShape(parsed.value, expectedTaskNumber);
}

function validateAmendmentShape(amendment: unknown): string | null {
    if (typeof amendment !== "object" || amendment === null) return "amendment is not an object";
    const { op, id, after, title, body } = amendment as Record<string, unknown>;
    if (op === "insert") {
        if (typeof after !== "string" || after === "") return "insert amendment is missing after";
        if (typeof id !== "string" || id === "") return "insert amendment is missing id";
        if (!SECTION_ID_PATTERN.test(id)) return `insert amendment id is not valid kebab-case: ${JSON.stringify(id)}`;
        if (typeof title !== "string") return "insert amendment is missing title";
        if (typeof body !== "string") return "insert amendment is missing body";
        return null;
    }
    if (op === "replace") {
        if (typeof id !== "string" || id === "") return "replace amendment is missing id";
        if (typeof body !== "string") return "replace amendment is missing body";
        if (title !== undefined && typeof title !== "string") return "replace amendment title must be a string";
        return null;
    }
    if (op === "remove") {
        if (typeof id !== "string" || id === "") return "remove amendment is missing id";
        return null;
    }
    return `unknown amendment op: ${JSON.stringify(op)}`;
}

export function readAndValidateReview(reviewFilePath: string): CodexReview | PlanProblem {
    const parsed = parseJsonFile(reviewFilePath);
    if ("problem" in parsed) return parsed;
    const value = parsed.value;
    if (typeof value !== "object" || value === null) return { problem: "review is not an object" };
    const review = value as Record<string, unknown>;
    if (review.verdict === "scrap") {
        if (typeof review.notes !== "string" || review.notes === "") {
            return { problem: "scrap verdict requires non-empty notes" };
        }
        return { verdict: "scrap", notes: review.notes };
    }
    if (review.verdict === "amend") {
        if (!Array.isArray(review.amendments) || review.amendments.length === 0) {
            return { problem: "amend verdict requires a non-empty amendments array" };
        }
        for (const amendment of review.amendments) {
            const problem = validateAmendmentShape(amendment);
            if (problem !== null) return { problem };
        }
        return {
            verdict: "amend",
            amendments: review.amendments as PlanAmendment[],
            ...(typeof review.notes === "string" ? { notes: review.notes } : {}),
        };
    }
    return { problem: `review verdict must be "amend" or "scrap", got ${JSON.stringify(review.verdict)}` };
}

function findAmendmentProblem(plan: Plan, amendments: PlanAmendment[]): string | null {
    if (amendments.length === 0) return "an amend verdict carries no amendments";
    const liveIds = new Set(plan.sections.map((section) => section.id));
    for (const amendment of amendments) {
        if (amendment.op === "insert") {
            if (!SECTION_ID_PATTERN.test(amendment.id)) {
                return `insert id is not valid kebab-case: ${JSON.stringify(amendment.id)}`;
            }
            if (!liveIds.has(amendment.after)) return `insert names unknown section "${amendment.after}"`;
            if (liveIds.has(amendment.id)) return `insert reuses existing id "${amendment.id}"`;
            liveIds.add(amendment.id);
            continue;
        }
        if (!liveIds.has(amendment.id)) return `${amendment.op} names unknown section "${amendment.id}"`;
        if (amendment.op === "remove") liveIds.delete(amendment.id);
    }
    if (liveIds.size === 0) return "amendment batch removes every section";
    return null;
}

function applyOneAmendment(sections: PlanSection[], amendment: PlanAmendment): PlanSection[] {
    if (amendment.op === "remove") return sections.filter((section) => section.id !== amendment.id);
    if (amendment.op === "replace") {
        return sections.map((section) => section.id !== amendment.id
            ? section
            : { id: section.id, title: amendment.title ?? section.title, body: amendment.body });
    }
    const insertAt = sections.findIndex((section) => section.id === amendment.after) + 1;
    return [...sections.slice(0, insertAt),
            { id: amendment.id, title: amendment.title, body: amendment.body },
            ...sections.slice(insertAt)];
}

export function applyPlanAmendments(plan: Plan, amendments: PlanAmendment[]): AmendmentResult {
    const problem = findAmendmentProblem(plan, amendments);
    if (problem !== null) return { status: "rejected", problem };
    const candidate = { ...plan, revision: plan.revision + 1, sections: amendments.reduce(applyOneAmendment, plan.sections) };
    const validated = validatePlanShape(candidate, plan.task);
    if (isPlanProblem(validated)) return { status: "rejected", problem: validated.problem };
    return { status: "applied", plan: validated };
}
