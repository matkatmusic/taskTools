// Run: node --test tests/emitPipelineOutput.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { annotatedBody, matchPathNumber } from "../scripts/tackle-tasks/emitPipelineOutput.ts";
import { skillBody } from "../scripts/tackle-tasks/SkillBodyEmitter.ts";
import { traceTaskPipeline, readNamedPaths } from "../scripts/tracePipeline.ts";

const temporaryDirectories: string[] = [];
after(() => {
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

// A throwaway repository, so emitting a body never marks a real task active.
const makeTargetRepository = (taskNumber: number): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "emitPipelineOutput-")));
    temporaryDirectories.push(root);
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "Target task" }]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), JSON.stringify([]));
    return root;
};

const emitterSource = readFileSync(
    fileURLToPath(new URL("../scripts/tackle-tasks/SkillBodyEmitter.ts", import.meta.url)),
    "utf8",
).split("\n");

const stripAnnotations = (body: string): string =>
    body.split("\n").filter((line) => !/^<!-- SkillBodyEmitter\.ts:\d+ -->$/.test(line)).join("\n");

test("test_annotatedBody_leavesTheEmittedBodyByteFaithfulOnceCommentsAreStripped", () => {
    // The file is a thing to craft, so the annotations must add nothing the emitter did not print.
    assert.equal(stripAnnotations(annotatedBody(74, makeTargetRepository(74))), skillBody("[74]", makeTargetRepository(74)));
});

test("test_annotatedBody_pointsEachLineAtTheSourceLineThatEmittedIt", () => {
    // Setup: pair every annotation with the body line directly beneath it.
    const lines = annotatedBody(74, makeTargetRepository(74)).split("\n");

    // Verification: the cited source line really holds that text, so annotations cannot shift.
    let checked = 0;
    for (let index = 0; index < lines.length - 1; index += 1) {
        const cited = /^<!-- SkillBodyEmitter\.ts:(\d+) -->$/.exec(lines[index]);
        if (cited === null) continue;
        // Only a line's opening run of plain text appears in the source verbatim.
        const plain = lines[index + 1].split(/[`$]/)[0].trim().slice(0, 20);
        if (plain.length < 8) continue;
        assert.ok(
            emitterSource[Number(cited[1]) - 1].includes(plain),
            `annotation ${cited[1]} does not point at "${plain}"`,
        );
        checked += 1;
    }
    assert.ok(checked >= 5, `expected several annotations to check, got ${checked}`);
});

test("test_matchPathNumber_identifiesTheFixtureThatProducedAPipelineBlock", () => {
    // Setup: the block the invalid-number path prints for a real task number.
    const invalidNumber = readNamedPaths()["invalid-number"];
    const trace = traceTaskPipeline({ ...invalidNumber, taskNumber: 191 });

    // Verification: matching is by block, not by decisions, and the fixture's position is the number.
    assert.deepEqual(matchPathNumber(trace, 191), { number: 1, name: "invalid-number" });
});

test("test_matchPathNumber_refusesABlockNoFixtureProduces", () => {
    // A silent fallback would name a file after the wrong path, so an unknown block must stop the run.
    assert.throws(() => matchPathNumber(["not a pipeline block"], 191), /matches no known fixture/);
});
