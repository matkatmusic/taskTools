// ARE_TESTS_FLAGGED, from pipeline-reviewTests.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { ReviewTestsCorePacket } from "./GREEN_IMPLEMENTATION_INPUT.ts";

export type AreTestsFlaggedInput = ReviewTestsCorePacket & { box: string; scriptSignal: string; flagged: boolean; notes: string };

export function main(input: string): Record<string, unknown> {
    const { box: _box, scriptSignal: _scriptSignal, flagged, notes, ...core } = JSON.parse(input) as AreTestsFlaggedInput;
    const next = flagged ? "ARE_2_TEST_REVIEWS_DONE" : "REBASE_PREAMBLE_PIPELINE";
    return { box: "ARE_TESTS_FLAGGED", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next, ...core, notes: flagged ? notes : "" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
