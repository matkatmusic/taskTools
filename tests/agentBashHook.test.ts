// Tests the PreToolUse Bash hook that blocks git and the full suite for fenced agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "hooks", "agentBashHook.ts");

function runHook(command: string): number {
    return spawnSync("node", ["--no-inspect", SCRIPT], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        encoding: "utf8",
    }).status!;
}

test("blocks git, npm test, and npm run test with exit 2, even after a separator", () => {
    assert.equal(runHook("git status"), 2);
    assert.equal(runHook("npm test"), 2);
    assert.equal(runHook("npm run test:baseline"), 2);
    assert.equal(runHook("cd /x && git add ."), 2);
    assert.equal(runHook("true; npm test"), 2);
});

test("lets every other command through with exit 0", () => {
    assert.equal(runHook("node --test tests/thing.test.ts"), 0);
    assert.equal(runHook("rg -n gitignore src"), 0);
    assert.equal(runHook("node scripts/writeAgentAnswer.ts /p <<'EOF'\n{}\nEOF"), 0);
});
