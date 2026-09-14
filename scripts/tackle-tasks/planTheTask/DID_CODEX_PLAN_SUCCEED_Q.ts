// DID_CODEX_PLAN_SUCCEED_Q: routes to the planner ruling on success, else falls back to PLAN_THE_TASK.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";

type Input = EntryPacket & { message: string; additionalData: { outcome: string; planFile: string; clarifyRequest: string } };

export function main(input: string): Record<string, unknown> {
    const { additionalData, ...packet } = JSON.parse(input) as Input;
    const doneFile = `${packet.worktree}/plans/PLAN_THE_TASK.codex-done`;
    const codexSucceeded = existsSync(doneFile) && readFileSync(doneFile, "utf8").trim() === "0";
    const output = { ...packet, box: "DID_CODEX_PLAN_SUCCEED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, message: "" };
    if (codexSucceeded) {
        return { ...output, additionalData, next: "pipeline-whatDidThePlannerReturn.mmd::WHAT_DID_THE_PLANNER_RETURN" };
    }
    return { ...output, additionalData: { outcome: "", planFile: "", clarifyRequest: "" }, next: "PLAN_THE_TASK" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
