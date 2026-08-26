// IS_REBASE_FINISHED, from pipeline-rebase.mmd. Decision: read-only, no lock refresh needed.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { RebasePacket } from "./packet.ts";

export function main(input: string): RebasePacket & { next: string } {
    const packet = JSON.parse(input) as RebasePacket;
    const next = packet.finished ? "SUITE_PIPELINE" : "DID_REBASE_REPORT_CONFLICTS";
    return { ...packet, box: "IS_REBASE_FINISHED", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
