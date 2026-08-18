// A box's schema must match what its emitter asks the agent to return.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    CONTINUE_REBASE_RESULT,
    FIX_CONFLICTS_RESULT,
    FIX_SUITE_RESULT,
    IMPLEMENT_RESULT,
    PLAN_RESULT,
    REBASE_WORKTREE_RESULT,
    REVIEW_PLAN_RESULT,
    REVIEW_TESTS_RESULT,
    RUN_FULL_SUITE_RESULT,
    RUN_TASK_TESTS_RESULT,
} from "../../scripts/tackle-tasks/pipelines.ts";

type Schema = { type: string; required: string[]; properties: Record<string, { enum?: string[] }> };

const read = (relativePath: string): string =>
    readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");

// A role whose agent fills in a JSON template file, so the template's keys are the contract.
const TEMPLATE_ROLES: { role: string; schema: Schema; template: string }[] = [
    { role: "plan", schema: PLAN_RESULT as Schema, template: "plans/plan-output-template.json" },
    { role: "review-plan", schema: REVIEW_PLAN_RESULT as Schema, template: "plans/review-plan-output-template.json" },
    { role: "implement", schema: IMPLEMENT_RESULT as Schema, template: "plans/implement-output-template.json" },
    { role: "review-tests", schema: REVIEW_TESTS_RESULT as Schema, template: "plans/review-tests-output-template.json" },
    { role: "fix-conflicts", schema: FIX_CONFLICTS_RESULT as Schema, template: "plans/fix-conflicts-output-template.json" },
    { role: "fix-suite", schema: FIX_SUITE_RESULT as Schema, template: "plans/fix-suite-output-template.json" },
];

// A role whose agent invokes a skill, so the emitter's own receipt type is the contract.
const SKILL_ROLES: { role: string; schema: Schema; emitter: string; receipt: string }[] = [
    { role: "run-task-tests", schema: RUN_TASK_TESTS_RESULT as Schema, emitter: "scripts/tackle-tasks/RunTaskTestsBodyEmitter.ts", receipt: "RunTaskTestsReceipt" },
    { role: "rebase-worktree", schema: REBASE_WORKTREE_RESULT as Schema, emitter: "scripts/tackle-tasks/RebaseWorktreeBodyEmitter.ts", receipt: "RebaseWorktreeReceipt" },
    { role: "continue-rebase", schema: CONTINUE_REBASE_RESULT as Schema, emitter: "scripts/tackle-tasks/ContinueRebaseBodyEmitter.ts", receipt: "ContinueRebaseReceipt" },
    { role: "run-full-suite", schema: RUN_FULL_SUITE_RESULT as Schema, emitter: "scripts/tackle-tasks/RunFullSuiteBodyEmitter.ts", receipt: "RunFullSuiteReceipt" },
];

for (const { role, schema, template } of TEMPLATE_ROLES) {
    test(`test_agentResultShape_${role.replace(/-/g, "_")}_schemaMatchesItsOutputTemplate`, () => {
        // Setup: the template is the only thing the agent is shown, so it is the contract.
        const templateKeys = Object.keys(JSON.parse(read(template)) as Record<string, string>);

        // Verification: neither side carries a key the other does not.
        assert.deepEqual(Object.keys(schema.properties).sort(), templateKeys.sort());
    });
}

for (const { role, schema, emitter, receipt } of SKILL_ROLES) {
    test(`test_agentResultShape_${role.replace(/-/g, "_")}_schemaMatchesItsEmitterReceipt`, () => {
        // Setup: this role has no template file; the emitter's receipt type states the shape.
        const source = read(emitter);
        const block = source.slice(source.indexOf(`export type ${receipt} = {`));
        const fields = [...block.slice(0, block.indexOf("};")).matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]);

        // Verification: the emitter names exactly the fields the schema declares.
        assert.ok(fields.length > 0, `no fields parsed from ${receipt}`);
        assert.deepEqual(Object.keys(schema.properties).sort(), fields.sort());
    });
}

test("test_agentResultShape_everyRequiredKeyIsAlsoADeclaredProperty", () => {
    // A required key with no property is a schema that can never be satisfied.
    for (const { role, schema } of [...TEMPLATE_ROLES, ...SKILL_ROLES]) {
        for (const key of schema.required) {
            assert.ok(key in schema.properties, `${role} requires ${key} but declares no such property`);
        }
    }
});

test("test_agentResultShape_plannerAndReviewerEnumsAreOfferedByTheirTemplates", () => {
    // The template's prose is what tells the agent which words are allowed, so it must list them all.
    const planTemplate = read("plans/plan-output-template.json");
    for (const value of (PLAN_RESULT as Schema).properties.outcome!.enum!) {
        assert.ok(planTemplate.includes(value), `plan template never offers outcome ${value}`);
    }

    const reviewTemplate = read("plans/review-plan-output-template.json");
    for (const value of (REVIEW_PLAN_RESULT as Schema).properties.verdict!.enum!) {
        assert.ok(reviewTemplate.includes(value), `review-plan template never offers verdict ${value}`);
    }
});
