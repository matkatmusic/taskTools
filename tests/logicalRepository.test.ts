// Behavioral checks for logicalRepository.ts: grouping occurrences by shared upstream identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLogicalRepositories } from "../scripts/logicalRepository.ts";
import type { RepositoryOccurrence } from "../scripts/repositoryManifest.ts";

function makeOccurrence(id: string, parentId: string | null, path: string, rawUrl: string): RepositoryOccurrence {
    return {
        occurrenceId: id,
        checkoutPath: path,
        parentOccurrenceId: parentId,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: rawUrl,
        baseBranch: "main",
        baseOid: "0".repeat(40),
        operationBranch: "",
        childOccurrenceIds: [],
        testState: "untested",
    };
}

const TMUX_LIB_URL = "https://example.com/group/tmux_lib.git";
const CLAUDE_PLUGIN_LIB_URL = "https://example.com/group/claude_plugin_lib.git";
const SCENARIOS_URL = "https://example.com/group/scenarios.git";
const ONLY_ONE_LIB_URL = "https://example.com/group/only_one_lib.git";

function buildMultiRepoFixture(): RepositoryOccurrence[] {
    return [
        makeOccurrence("tmux1", null, "tmux_lib", TMUX_LIB_URL),
        makeOccurrence("tmux2", "jfred", "jfred/external/tmux_lib", TMUX_LIB_URL),
        makeOccurrence(
            "tmux3",
            "jfredToolsPlugin",
            "jfred/jfredToolsPlugin/external/tmux_lib",
            TMUX_LIB_URL,
        ),
        makeOccurrence("plugin1", "jfred", "jfred/claude_plugin_lib", CLAUDE_PLUGIN_LIB_URL),
        makeOccurrence("plugin2", "other", "other/claude_plugin_lib", CLAUDE_PLUGIN_LIB_URL),
        makeOccurrence("scenarios1", "jfred", "jfred/scenarios", SCENARIOS_URL),
        makeOccurrence("scenarios2", "other", "other/scenarios", SCENARIOS_URL),
        makeOccurrence("only1", null, "only_one_lib", ONLY_ONE_LIB_URL),
    ];
}

test("test_groupsThreeOccurrencesOfSameUpstreamIntoOneLogicalRepository", () => {
    const logicalRepositories = buildLogicalRepositories(buildMultiRepoFixture());
    const tmuxGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("tmux1"));
    assert.ok(tmuxGroup);
    assert.equal(tmuxGroup.occurrenceIds.length, 3);
    assert.deepEqual(new Set(tmuxGroup.occurrenceIds), new Set(["tmux1", "tmux2", "tmux3"]));
});

test("test_preservesEachOccurrencesParentEdgeAndPath", () => {
    const fixture = buildMultiRepoFixture();
    const snapshot = fixture.map((occurrence) => ({ ...occurrence }));
    buildLogicalRepositories(fixture);
    fixture.forEach((occurrence, index) => {
        assert.equal(occurrence.occurrenceId, snapshot[index].occurrenceId);
        assert.equal(occurrence.parentOccurrenceId, snapshot[index].parentOccurrenceId);
        assert.equal(occurrence.checkoutPath, snapshot[index].checkoutPath);
    });
});

test("test_groupsTwoOccurrencesOfClaudePluginLibIntoOwnTwoMemberClass", () => {
    const logicalRepositories = buildLogicalRepositories(buildMultiRepoFixture());
    const pluginGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("plugin1"));
    const tmuxGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("tmux1"));
    const scenariosGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("scenarios1"));
    assert.ok(pluginGroup);
    assert.equal(pluginGroup.occurrenceIds.length, 2);
    assert.deepEqual(new Set(pluginGroup.occurrenceIds), new Set(["plugin1", "plugin2"]));
    assert.notEqual(pluginGroup, tmuxGroup);
    assert.notEqual(pluginGroup, scenariosGroup);
});

test("test_groupsTwoOccurrencesOfScenariosIntoOwnTwoMemberClass", () => {
    const logicalRepositories = buildLogicalRepositories(buildMultiRepoFixture());
    const scenariosGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("scenarios1"));
    assert.ok(scenariosGroup);
    assert.equal(scenariosGroup.occurrenceIds.length, 2);
    assert.deepEqual(new Set(scenariosGroup.occurrenceIds), new Set(["scenarios1", "scenarios2"]));
});

test("test_formsOneMemberClassForUniqueRepository", () => {
    const logicalRepositories = buildLogicalRepositories(buildMultiRepoFixture());
    const onlyOneGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("only1"));
    assert.ok(onlyOneGroup);
    assert.equal(onlyOneGroup.occurrenceIds.length, 1);
    assert.equal(onlyOneGroup.consolidationState, "single");
});

test("test_supportsFourOrMoreOccurrencesOfOneLogicalRepository", () => {
    const fiveOccurrences = Array.from({ length: 5 }, (_, index) =>
        makeOccurrence(`shared${index}`, null, `path${index}`, TMUX_LIB_URL),
    );
    const logicalRepositories = buildLogicalRepositories(fiveOccurrences);
    assert.equal(logicalRepositories.length, 1);
    assert.equal(logicalRepositories[0].occurrenceIds.length, 5);
    assert.deepEqual(
        new Set(logicalRepositories[0].occurrenceIds),
        new Set(["shared0", "shared1", "shared2", "shared3", "shared4"]),
    );
});

test("test_overlayNeverDropsMergesOrReparentsAnyOccurrenceAcrossFullFixture", () => {
    const fixture = buildMultiRepoFixture();
    const logicalRepositories = buildLogicalRepositories(fixture);
    const flattenedIds = logicalRepositories.flatMap((repo) => repo.occurrenceIds);
    assert.deepEqual(new Set(flattenedIds), new Set(fixture.map((occurrence) => occurrence.occurrenceId)));
    assert.equal(logicalRepositories.length, 4);
    assert.equal(flattenedIds.length, new Set(flattenedIds).size);
});

test("test_eachLogicalRepositoryIncludesRequiredRecordFields", () => {
    const fixture = [
        makeOccurrence("a1", null, "a", ONLY_ONE_LIB_URL),
        makeOccurrence("a2", "a1", "a/nested", ONLY_ONE_LIB_URL),
    ];
    const [logicalRepository] = buildLogicalRepositories(fixture);
    assert.ok(logicalRepository.normalizedIdentity);
    assert.deepEqual(logicalRepository.occurrenceIds, ["a1", "a2"]);
    assert.ok(logicalRepository.occurrenceIds.includes(logicalRepository.selectedBaseOccurrenceId));
    assert.ok(logicalRepository.occurrenceIds.includes(logicalRepository.canonicalOccurrenceId));
    assert.equal(typeof logicalRepository.convergenceDigest, "string");
    assert.equal(logicalRepository.consolidationState, "grouped");
});
