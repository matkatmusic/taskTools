// Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q, from pipeline-preambleStatusCheck.mmd. Copy of lockSourceRepo/HAS_LOCK_WAIT_DEADLINE_PASSED_Q.ts.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { LOCK_WAIT_DEADLINE_MS } from "../lockSourceRepo/HAS_LOCK_WAIT_DEADLINE_PASSED_Q.ts";
import type { EntryPacket } from "./_packet.ts";

type Input = EntryPacket & { lockWaitStartedAt: string; next?: string };

export function main(input: string): EntryPacket & { lockWaitStartedAt: string; next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as Input;
    const elapsedMs = Date.now() - Date.parse(packet.lockWaitStartedAt);
    // A blocked catch-up is not a pipeline failure, so a passed deadline reports and stops.
    if (elapsedMs >= LOCK_WAIT_DEADLINE_MS) {
        return {
            ...packet,
            box: "Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q",
            scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            exitType: "catch-up-lock-timeout",
            exitNote: "the lock wait deadline passed",
            next: "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT",
        };
    }
    return { ...packet, box: "Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "B_WAIT_FOR_CATCH_UP_LOCK" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
