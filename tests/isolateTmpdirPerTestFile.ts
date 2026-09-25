// Preload: gives each test process its own temp folder, removed on exit, so leftover mkdtemp folders never pile up.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedTmpdir = mkdtempSync(join(tmpdir(), "taskTools-test-"));
process.env.TMPDIR = isolatedTmpdir;
process.env.TMP = isolatedTmpdir;
process.env.TEMP = isolatedTmpdir;
process.on("exit", () => rmSync(isolatedTmpdir, { recursive: true, force: true }));
