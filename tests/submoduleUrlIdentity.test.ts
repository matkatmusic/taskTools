// submoduleUrlIdentity.ts: relative URL resolution, identity normalization, and multi-occurrence agreement.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    resolveRelativeSubmoduleUrl,
    normalizeRepositoryIdentity,
    resolveSubmoduleUpstreamIdentity,
} from "../scripts/submoduleUrlIdentity.ts";
import type { SubmoduleOccurrence } from "../scripts/submoduleUrlIdentity.ts";

// "../x" walks up one directory, replacing only the last path segment.
test("test_relativeSubmoduleUrlResolvesAgainstParentOrigin", () => {
    const resolved = resolveRelativeSubmoduleUrl("../tmux_lib.git", "https://example.com/group/parent.git");
    assert.equal(resolved, "https://example.com/group/tmux_lib.git");
});

// "./x" resolves in place, next to the parent's own path.
test("test_relativeSubmoduleUrlWithDotSlashResolvesInPlace", () => {
    const resolved = resolveRelativeSubmoduleUrl("./sibling.git", "https://example.com/group/parent.git");
    assert.equal(resolved, "https://example.com/group/sibling.git");
});

// "../../x/y" walks up two directories before descending back into "other/".
test("test_relativeSubmoduleUrlWalksMultipleLevelsUp", () => {
    const resolved = resolveRelativeSubmoduleUrl("../../other/repo.git", "https://example.com/a/b/parent.git");
    assert.equal(resolved, "https://example.com/other/repo.git");
});

// scp-style parent has no "/" left, so the walk crosses the ":" boundary instead.
test("test_relativeSubmoduleUrlResolvesAgainstScpStyleParentOrigin", () => {
    const resolved = resolveRelativeSubmoduleUrl("../tmux_lib.git", "git@host:group/parent.git");
    assert.equal(resolved, "git@host:tmux_lib.git");
});

// scp-style, ssh://, and https:// forms of the same repo normalize to one identity.
test("test_scpSshAndHttpsUrlsNormalizeToSameIdentity", () => {
    const expected = { host: "host", owner: "owner", repository: "repo" };
    assert.deepEqual(normalizeRepositoryIdentity("git@host:owner/repo.git"), expected);
    assert.deepEqual(normalizeRepositoryIdentity("ssh://git@host/owner/repo"), expected);
    assert.deepEqual(normalizeRepositoryIdentity("https://host/owner/repo.git"), expected);
});

// Two occurrences on different hosts must not resolve to the same repository.
test("test_differingHostDoesNotNormalizeToSameIdentity", () => {
    const occurrences: SubmoduleOccurrence[] = [
        { path: "lib/a", url: "https://hostA/owner/repo.git", parentOriginUrl: undefined },
        { path: "lib/b", url: "https://hostB/owner/repo.git", parentOriginUrl: undefined },
    ];
    const result = resolveSubmoduleUpstreamIdentity(occurrences);
    assert.equal(result.status, "resolution-required");
});

// Two occurrences with the same host but different owners must not resolve to the same repository.
test("test_differingOwnerDoesNotNormalizeToSameIdentity", () => {
    const occurrences: SubmoduleOccurrence[] = [
        { path: "lib/a", url: "https://host/ownerA/repo.git", parentOriginUrl: undefined },
        { path: "lib/b", url: "https://host/ownerB/repo.git", parentOriginUrl: undefined },
    ];
    const result = resolveSubmoduleUpstreamIdentity(occurrences);
    assert.equal(result.status, "resolution-required");
});

// Case differences in scheme/host/owner/repo/.git suffix normalize away.
test("test_caseDiffersButIdentityNormalizesTheSame", () => {
    const a = normalizeRepositoryIdentity("HTTPS://Host.Example.COM/Owner/Repo.GIT");
    const b = normalizeRepositoryIdentity("https://host.example.com/owner/repo.git");
    assert.deepEqual(a, b);
});

// A trailing slash and an explicit .git suffix normalize to the same identity.
test("test_trailingSlashAndDotGitSuffixNormalizeToSameIdentity", () => {
    const a = normalizeRepositoryIdentity("https://host/owner/repo/");
    const b = normalizeRepositoryIdentity("https://host/owner/repo.git");
    assert.deepEqual(a, b);
});

// An explicit default https port (443) collapses into the bare host.
test("test_defaultHttpsPortNormalizesToSameIdentity", () => {
    const a = normalizeRepositoryIdentity("https://host:443/owner/repo.git");
    const b = normalizeRepositoryIdentity("https://host/owner/repo.git");
    assert.deepEqual(a, b);
});

// An explicit default ssh port (22) collapses into the bare host, matching scp-style (implicitly ssh).
test("test_defaultSshPortNormalizesToSameIdentity", () => {
    const a = normalizeRepositoryIdentity("ssh://git@host:22/owner/repo.git");
    const b = normalizeRepositoryIdentity("git@host:owner/repo.git");
    assert.deepEqual(a, b);
});

// A non-default port is folded into the host string, so it is not treated as the same repository.
test("test_nonDefaultPortDoesNotNormalizeToSameIdentity", () => {
    const a = normalizeRepositoryIdentity("https://host:8443/owner/repo.git");
    const b = normalizeRepositoryIdentity("https://host/owner/repo.git");
    assert.notDeepEqual(a, b);
});

// A missing .gitmodules url entry cannot be resolved at all.
test("test_missingGitmodulesUrlProducesResolutionRequest", () => {
    const occurrences: SubmoduleOccurrence[] = [
        { path: "lib/tmux", url: undefined, parentOriginUrl: "https://host/group/parent.git" },
    ];
    const result = resolveSubmoduleUpstreamIdentity(occurrences);
    assert.equal(result.status, "resolution-required");
    if (result.status === "resolution-required") {
        assert.ok(result.reason.length > 0);
        assert.deepEqual(result.occurrences, occurrences);
    }
});

// A relative url with no parent origin available cannot be resolved.
test("test_missingParentOriginProducesResolutionRequestForRelativeUrl", () => {
    const occurrences: SubmoduleOccurrence[] = [
        { path: "lib/tmux", url: "../tmux_lib.git", parentOriginUrl: undefined },
    ];
    const result = resolveSubmoduleUpstreamIdentity(occurrences);
    assert.equal(result.status, "resolution-required");
});

// An absolute url bypasses the relative-resolution/parent-origin requirement entirely.
test("test_absoluteUrlDoesNotRequireParentOrigin", () => {
    const occurrences: SubmoduleOccurrence[] = [
        { path: "lib/tmux", url: "https://host/owner/tmux_lib.git", parentOriginUrl: undefined },
    ];
    const result = resolveSubmoduleUpstreamIdentity(occurrences);
    assert.equal(result.status, "resolved");
});

// Two occurrences of the same submodule, seen from different parents in different url forms, agree.
test("test_resolveSubmoduleUpstreamIdentityResolvesWhenAllOccurrencesAgree", () => {
    const occurrences: SubmoduleOccurrence[] = [
        { path: "lib/tmux", url: "../tmux_lib.git", parentOriginUrl: "https://host/owner/parent.git" },
        { path: "vendor/tmux", url: "git@host:owner/tmux_lib.git", parentOriginUrl: undefined },
    ];
    const result = resolveSubmoduleUpstreamIdentity(occurrences);
    assert.equal(result.status, "resolved");
    if (result.status === "resolved") {
        assert.deepEqual(result.identity, { host: "host", owner: "owner", repository: "tmux_lib" });
    }
});

// Two occurrences that resolve to genuinely different owners must surface both for review.
test("test_resolveSubmoduleUpstreamIdentityRequestsResolutionWhenOccurrencesDisagree", () => {
    const occurrences: SubmoduleOccurrence[] = [
        { path: "lib/tmux", url: "https://host/ownerA/tmux_lib.git", parentOriginUrl: undefined },
        { path: "vendor/tmux", url: "https://host/ownerB/tmux_lib.git", parentOriginUrl: undefined },
    ];
    const result = resolveSubmoduleUpstreamIdentity(occurrences);
    assert.equal(result.status, "resolution-required");
    if (result.status === "resolution-required") {
        assert.deepEqual(result.occurrences, occurrences);
    }
});

// An unparseable absolute url must produce a resolution request instead of throwing.
test("test_unparseableUrlProducesResolutionRequestInsteadOfThrowing", () => {
    const occurrences: SubmoduleOccurrence[] = [
        { path: "lib/tmux", url: "not a url", parentOriginUrl: undefined },
    ];
    assert.doesNotThrow(() => resolveSubmoduleUpstreamIdentity(occurrences));
    const result = resolveSubmoduleUpstreamIdentity(occurrences);
    assert.equal(result.status, "resolution-required");
});
