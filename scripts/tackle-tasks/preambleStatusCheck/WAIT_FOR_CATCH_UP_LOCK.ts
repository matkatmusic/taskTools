// B_WAIT_FOR_CATCH_UP_LOCK, from pipeline-preambleStatusCheck.mmd. Copy of lockSourceRepo/WAIT_FOR_LOCK.ts.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { EntryPacket } from "./_packet.ts";

// The same knob as lockSourceRepo/WAIT_FOR_LOCK.ts, so one setting shortens every lock wait in a test.
const WAIT_MS = Number(process.env.WAIT_FOR_LOCK_MS ?? 5_000);
const WAIT = new Int32Array(new SharedArrayBuffer(4));

type Input = EntryPacket & { lockWaitStartedAt: string; next?: string };

export function main(input: string): EntryPacket & { lockWaitStartedAt: string } {
    const { next: _next, ...packet } = JSON.parse(input) as Input;
    Atomics.wait(WAIT, 0, 0, WAIT_MS);
    return { ...packet, box: "B_WAIT_FOR_CATCH_UP_LOCK", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
