// A box's schema must match what its emitter asks the agent to return.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    FIX_CONFLICTS_RESULT,
    FIX_SUITE_RESULT,
    IMPLEMENT_RESULT,
    PLAN_RESULT,
    REVIEW_PLAN_RESULT,
    REVIEW_TESTS_RESULT,
} from "../scripts/tackle-tasks/pipelines.ts";

type Schema = { type: string; required: string[]; properties: Record<string, { enum?: string[] }> };

const read = (relativePath: string): string =>
    readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");

// A role whose agent fills in a JSON template file, so the template's keys are the contract.
const TEMPLATE_ROLES: { role: string; schema: Schema; template: string }[] = [
    { role: "plan", schema: PLAN_RESULT as Schema, template: "plans/plan-output-template.json" },
    { role: "review-plan", schema: REVIEW_PLAN_RESULT as Schema, template: "plans/review-plan-output-template.json" },
    { role: "implement", schema: IMPLEMENT_RESULT as Schema, template: "plans/implement-output-template.json" },
    { role: "review-tests", schema: REVIEW_TESTS_RESULT as Schema, template: "plans/review-tests-output-template.json" },
    { role: "fix-conflicts", schema: FIX_CONFLICTS_RESULT as Schema, template: "plans/fix-conflicts-output-template.json" },
    { role: "fix-suite", schema: FIX_SUITE_RESULT as Schema, template: "plans/fix-suite-output-template.json" },
];

for (const { role, schema, template } of TEMPLATE_ROLES) {
    test(`test_agentResultShape_${role.replace(/-/g, "_")}_schemaMatchesItsOutputTemplate`, () => {
        // Setup: the template is the only thing the agent is shown, so it is the contract.
        const templateKeys = Object.keys(JSON.parse(read(template)) as Record<string, string>);

        // Verification: neither side carries a key the other does not.
        assert.deepEqual(Object.keys(schema.properties).sort(), templateKeys.sort());
    });
}

test("test_agentResultShape_everyRequiredKeyIsAlsoADeclaredProperty", () => {
    // A required key with no property is a schema that can never be satisfied.
    for (const { role, schema } of TEMPLATE_ROLES) {
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
