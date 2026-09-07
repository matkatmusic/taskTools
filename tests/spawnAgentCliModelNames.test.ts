// Every --model flag in spawnAgentCli.ts names a real Claude model.  Run alone: node --test tests/spawnAgentCliModelNames.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ALLOWED_MODELS = ["fable", "opus", "sonnet", "haiku", "claude-fable-5-1", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

test("test_spawnAgentCli_everyModelFlagIsAnAllowedModelName", () => {
    const source = readFileSync(fileURLToPath(new URL("../scripts/tackle-tasks/shared/spawnAgentCli.ts", import.meta.url)), "utf8");
    const models = [...source.matchAll(/--model\s+(\S+)/g)].map((match) => match[1]);
    assert.ok(models.length > 0, "no --model flag found");
    for (const model of models) assert.ok(ALLOWED_MODELS.includes(model), `"${model}" is not an allowed model name`);
});
