// Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q, from pipeline-preambleStatusCheck.mmd. Copy of lockSourceRepo/WAS_LOCK_ACQUIRED_Q.ts.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { EntryPacket } from "./_packet.ts";

type Input = EntryPacket & { lockWaitStartedAt: string; acquired: boolean; heldByOwner: string; next?: string };

export function main(input: string): EntryPacket & { lockWaitStartedAt: string; next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as Input;
    if (packet.acquired) {
        return { ...packet, box: "Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "Q_CATCH_UP_STAGING" };
    }
    return { ...packet, box: "Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
