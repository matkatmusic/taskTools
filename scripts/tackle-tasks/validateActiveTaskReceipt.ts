// CLI for "is the active task receipt structure valid?" (plans/diagram/pipeline-preamble.mmd).
// The receipt composes the fields the preamble pipeline actually produces by the time it
// reaches ACTIVE_TASK_WORKTREE_RECEIPT: the task number (input), worktree + branch (from
// create/reset-worktree), briefFile (from generate/update-docs), and initialized (from
// init-submodules). Reads stdin JSON, writes one line of JSON to stdout.
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export type ActiveTaskWorktreeReceipt = {
    taskNumber: number;
    worktree: string;
    branch: string;
    briefFile: string;
    initialized: boolean;
};

export type ValidateActiveTaskReceiptInput = { receipt: unknown; taskNumber: number };
export type ValidateActiveTaskReceiptOutput = { valid: boolean; problem: string | null };

export function validateActiveTaskReceipt(input: ValidateActiveTaskReceiptInput): ValidateActiveTaskReceiptOutput {
    const receipt = input.receipt;
    if (typeof receipt !== "object" || receipt === null) return { valid: false, problem: "receipt is not an object" };
    const r = receipt as Record<string, unknown>;

    if (!Number.isInteger(r.taskNumber) || r.taskNumber !== input.taskNumber) {
        return { valid: false, problem: `receipt.taskNumber must equal ${input.taskNumber}` };
    }
    if (typeof r.worktree !== "string" || !isAbsolute(r.worktree)) {
        return { valid: false, problem: "receipt.worktree must be an absolute path" };
    }
    if (typeof r.branch !== "string" || r.branch.length === 0) {
        return { valid: false, problem: "receipt.branch must be a non-empty string" };
    }
    if (typeof r.briefFile !== "string" || !isAbsolute(r.briefFile)) {
        return { valid: false, problem: "receipt.briefFile must be an absolute path" };
    }
    if (typeof r.initialized !== "boolean") {
        return { valid: false, problem: "receipt.initialized must be a boolean" };
    }
    return { valid: true, problem: null };
}

if (process.argv[1]?.endsWith("validateActiveTaskReceipt.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as ValidateActiveTaskReceiptInput;
    process.stdout.write(`${JSON.stringify(validateActiveTaskReceipt(input))}\n`);
}
