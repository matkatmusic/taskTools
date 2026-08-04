// Behavioral checks for runAuthorization.ts: opaque finalization authorization token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { issueRunAuthorization, runFinalization } from "../scripts/runAuthorization.ts";

test("test_rejectsACallMissingTheAuthorizationToken", () => {
    // Omitting the token shifts args; runtime guard must reject the resulting non-token value.
    // @ts-expect-error - omitting the token is the behavior under test
    assert.throws(() => runFinalization("some-digest", () => "mutated"));
});

test("test_rejectsATokenWhoseDigestNoLongerMatchesCurrentState", () => {
    // Token issued for digest-a; finalizing against digest-b must throw and skip mutate.
    const token = issueRunAuthorization("digest-a");
    let mutateCallCount = 0;
    const mutate = () => { mutateCallCount++; return "mutated"; };
    assert.throws(() => runFinalization(token, "digest-b", mutate));
    assert.equal(mutateCallCount, 0);
});

test("test_acceptsATokenWhoseDigestMatchesCurrentState", () => {
    // Token and current digest match, so mutate must run once and return its result.
    const token = issueRunAuthorization("digest-a");
    let mutateCallCount = 0;
    const mutate = () => { mutateCallCount++; return "mutated"; };
    const result = runFinalization(token, "digest-a", mutate);
    assert.equal(result, "mutated");
    assert.equal(mutateCallCount, 1);
});

test("test_noProductionModuleOtherThanThePhase4ApprovalRecorderImportsIssueRunAuthorization", () => {
    // Scan scripts/ for issueRunAuthorization imports; only allowlisted files (the approval recorder) may use it.
    const allowedImporters = new Set<string>(["approvalGate.ts"]);
    const scriptsDir = join(import.meta.dirname, "..", "scripts");
    const scriptFiles = readdirSync(scriptsDir).filter((file) => file.endsWith(".ts") && file !== "runAuthorization.ts");
    for (const file of scriptFiles) {
        const contents = readFileSync(join(scriptsDir, file), "utf8");
        if (contents.includes("issueRunAuthorization")) {
            assert.equal(allowedImporters.has(file), true);
        }
    }
});
