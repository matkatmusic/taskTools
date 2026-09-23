// Loaded with --import by test script; gives each process its own worktree root, deleted on exit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "taskTools-wt-test-"));
process.env.TASKTOOLS_WT_ROOT = root;
// ponytail: exit only, so a SIGKILLed top-level run leaks its one root; add a signal handler if that shows up.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
