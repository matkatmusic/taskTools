import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCliCommand, codexExecCommand } from "./spawnAgentCli.ts";

test("test_claudeCliCommand_acceptsEditsAndAllowsOnlyNodeAndGitInBash", () => {
    // Setup: the shell line every agent-driven block spawns.
    const command = claudeCliCommand();
    // Verification: no blanket permission skip; edits are accepted and Bash is limited to node and git.
    assert.doesNotMatch(command, /dangerously-skip-permissions/);
    assert.match(command, /--permission-mode acceptEdits/);
    assert.match(command, /--allowedTools "Bash\(node \*\)" "Bash\(git \*\)"/);
});

test("test_codexExecCommand_rendersAFailingCommandWhenTheForceFailSwitchIsSet", () => {
    process.env.TASKTOOLS_FORCE_CODEX_FAIL = "1";
    const forced = codexExecCommand("/schema.json");
    delete process.env.TASKTOOLS_FORCE_CODEX_FAIL;
    assert.match(forced, /; false$/);
    assert.doesNotMatch(forced, /codex exec/);
    assert.match(codexExecCommand("/schema.json"), /codex exec/);
});
