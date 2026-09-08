// DID_REBASE_REPORT_CONFLICTS_Q, from pipeline-rebase.mmd. Decision: read-only, no lock refresh needed.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { RebasePacket } from "./_packet.ts";

export function main(input: string): RebasePacket & { next: string } {
    const packet = JSON.parse(input) as RebasePacket;
    const next = packet.conflicted ? "ARE_2_CONFLICT_FIXES_DONE_Q" : "pipeline-runFullSuite.mmd::RUN_FULL_SUITE";
    return { ...packet, box: "DID_REBASE_REPORT_CONFLICTS_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
