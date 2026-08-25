// WHAT_IS_PUBLICATION_STATE, from pipeline-merge.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type Incoming = {
    state: "ALL LANDED" | "SOME LANDED" | "NONE LANDED";
};

// merged, no-op and root-merged-but-not-closed are LANDED; conflicted is not (paragraph 73).
function nextBoxFor(state: Incoming["state"]): string {
    if (state === "ALL LANDED") return "PUBLICATION_ALL";
    if (state === "NONE LANDED") return "PUBLICATION_NONE";
    return "PUBLICATION_PARTIAL";
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Incoming;
    return { ...packet, box: "WHAT_IS_PUBLICATION_STATE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: nextBoxFor(packet.state) };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
