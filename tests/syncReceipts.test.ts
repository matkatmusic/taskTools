// Behavioral checks for syncReceipts.ts: receipt assembly and lossless (de)serialization.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSyncReceipt, serializeSyncReceipt, parseSyncReceipt } from "../scripts/syncReceipts.ts";
import type { Occurrence, SyncDestination } from "../scripts/syncReceipts.ts";

const source: Occurrence = { id: "root", parentChain: [] };

test("test_listsAllDestinationsWithTheirBranchesDigestsAndDistinctParentChainsForAThreeOccurrenceSync", () => {
    // Build three destinations, each with its own occurrence, branch, and digest.
    const destinations: SyncDestination[] = [
        { occurrence: { id: "childA", parentChain: ["root"] }, branch: "branch-a", contentDigest: "digest-a" },
        { occurrence: { id: "childB", parentChain: ["root"] }, branch: "branch-b", contentDigest: "digest-b" },
        { occurrence: { id: "childC", parentChain: ["root"] }, branch: "branch-c", contentDigest: "digest-c" },
    ];

    // Build the receipt from the source occurrence and the three destinations.
    const receipt = buildSyncReceipt("logicalRepo1", source, ["src/a.ts"], destinations);

    // Every destination should come through unchanged, in the same order.
    assert.equal(receipt.destinations.length, 3);
    destinations.forEach((expected, index) => {
        assert.equal(receipt.destinations[index].branch, expected.branch);
        assert.equal(receipt.destinations[index].contentDigest, expected.contentDigest);
        assert.deepEqual(receipt.destinations[index].occurrence.parentChain, expected.occurrence.parentChain);
    });
});

test("test_serializesAndParsesAReceiptLosslessly", () => {
    // Reuse fixture 1's inputs to build a valid receipt.
    const destinations: SyncDestination[] = [
        { occurrence: { id: "childA", parentChain: ["root"] }, branch: "branch-a", contentDigest: "digest-a" },
    ];
    const receipt = buildSyncReceipt("logicalRepo1", source, ["src/a.ts"], destinations);

    // Serialize to JSON, then parse it back.
    const json = serializeSyncReceipt(receipt);
    const roundTripped = parseSyncReceipt(json);

    // The round-tripped receipt should be identical to the original.
    assert.deepEqual(roundTripped, receipt);
});

test("test_recordsTheFullParentChainToRootForANestedOccurrenceNotJustTheImmediateParent", () => {
    // Build a destination whose parentChain has more than one ancestor.
    const nestedOccurrence: Occurrence = { id: "deepChild", parentChain: ["parentA", "grandparentB", "rootC"] };
    const destinations: SyncDestination[] = [
        { occurrence: nestedOccurrence, branch: "branch-deep", contentDigest: "digest-deep" },
    ];

    const receipt = buildSyncReceipt("logicalRepo1", source, [], destinations);

    // The full ancestor array should be preserved, not truncated to one element.
    assert.deepEqual(receipt.destinations[0].occurrence.parentChain, ["parentA", "grandparentB", "rootC"]);
});

test("test_givesTwoOccurrencesOfTheSameLogicalChildUnderDifferentParentsDifferentParentChains", () => {
    // Build two destinations with the same trailing id segment but different parent chains.
    const underRepoA: Occurrence = { id: "shared/vendor/lib", parentChain: ["repoA"] };
    const underRepoB: Occurrence = { id: "shared/vendor/lib", parentChain: ["repoB"] };
    const destinations: SyncDestination[] = [
        { occurrence: underRepoA, branch: "branch-repoA", contentDigest: "digest-repoA" },
        { occurrence: underRepoB, branch: "branch-repoB", contentDigest: "digest-repoB" },
    ];

    const receipt = buildSyncReceipt("logicalRepo1", source, [], destinations);

    // The two parent chains must differ and each must match its own fixture.
    assert.notDeepEqual(receipt.destinations[0].occurrence.parentChain, receipt.destinations[1].occurrence.parentChain);
    assert.deepEqual(receipt.destinations[0].occurrence.parentChain, ["repoA"]);
    assert.deepEqual(receipt.destinations[1].occurrence.parentChain, ["repoB"]);
});
