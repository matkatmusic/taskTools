# Task 11 Plan: Submodule URL Identity Resolution and Normalization

## Scope

Create two new files only. No existing file is modified, no production
call site wires this module in yet (per brief).

- `scripts/submoduleUrlIdentity.ts` — new module
- `tests/submoduleUrlIdentity.test.ts` — new test file

## Before writing any code

Read `tests/resolutionRequests.test.ts` and `scripts/resolutionRequests.ts`
to see whether a `ResolutionRequest` type / constructor already exists.

- If a compatible shape exists (a request object carrying a reason and the
  offending inputs), reuse it — import the type/constructor instead of
  defining a parallel one. This keeps the eventual Phase 3/4 consumer able
  to handle one resolution-request shape instead of two.
- If nothing compatible exists, define the local minimal shape given below.
  Do not build a shared abstraction for a "New module only" task — that is
  scope creep past what this task asks for.

Also open one neighboring test file (e.g. `tests/repositoryGraph.test.ts` or
`tests/resolutionRequests.test.ts`) to match this repo's test-runner import
style (`bun:test` vs `vitest`, `describe`/`it` vs `test`) and file-header
conventions exactly. Do not introduce a new test-running convention.

## Why this design

Git's own `git submodule` resolves a relative `.gitmodules` URL against the
**immediate parent's** origin URL, not the top-level repo's origin — this
matters for nested submodules. Reinventing that logic differently than git
does would silently diverge from what `git submodule update` itself
resolves, so the relative-resolution algorithm below is a direct port of
git's `resolve_relative_url` shell function (from `git-submodule.sh`), not
a from-scratch design. Port it as-is; do not "simplify" the `../` walk —
its exact stopping conditions (parent has no more `/` but has a `:`, then
truly out of parent) are what make it correct for both scp-style and URL
parents.

Normalization intentionally targets exactly the three identity fields the
brief names — host, owner, repository — plus the four dimensions the brief
names as included in that normalization (case, trailing `.git`, trailing
slashes, default ports). Nothing beyond that (e.g. query strings,
credentials-in-URL, `.git` suffix variants like `.GIT`) is in scope; add
it only if a future task's tests demand it.

## Types

```ts
export interface SubmoduleOccurrence {
    path: string;
    url: string | undefined;            // raw .gitmodules value; undefined = missing entry
    parentOriginUrl: string | undefined; // immediate parent's origin URL; undefined = unavailable
}

export interface RepositoryIdentity {
    host: string;
    owner: string;
    repository: string;
}

export type SubmoduleIdentityResolution =
    | { status: "resolved"; identity: RepositoryIdentity }
    | { status: "resolution-required"; reason: string; occurrences: SubmoduleOccurrence[] };
```

If `scripts/resolutionRequests.ts` already exports a `ResolutionRequest`
type/constructor, replace the inline `resolution-required` branch's shape
with that type instead (construct it via the existing constructor function
rather than an object literal), keeping `reason` and `occurrences` (or
their equivalent fields) populated the same way.

## Algorithms

### 1. Relative URL resolution — port of git's `resolve_relative_url`

```ts
function resolveRelativeSubmoduleUrl(relativeUrl: string, parentOriginUrl: string): string {
    let remoteUrl = parentOriginUrl.replace(/\/+$/, "");
    let separator = "/";
    let remainder = relativeUrl;

    while (remainder.length > 0) {
        if (remainder.startsWith("../")) {
            remainder = remainder.slice(3);
            if (remoteUrl.includes("/")) {
                remoteUrl = remoteUrl.slice(0, remoteUrl.lastIndexOf("/"));
            } else if (remoteUrl.includes(":")) {
                remoteUrl = remoteUrl.slice(0, remoteUrl.lastIndexOf(":"));
                separator = "";
            } else {
                throw new Error(
                    `cannot resolve relative submodule url "${relativeUrl}" past root of "${parentOriginUrl}"`
                );
            }
            continue;
        }
        if (remainder.startsWith("./")) {
            remainder = remainder.slice(2);
            continue;
        }
        break;
    }

    return remoteUrl + separator + remainder.replace(/\/+$/, "");
}
```

Only call this when `url` starts with `./` or `../`. An already-absolute
URL is returned unchanged by the wrapper below — it is never passed
through this function.

### 2. Wrapper that decides relative vs. absolute, and detects "unavailable"

```ts
function resolveSubmoduleUrl(url: string, parentOriginUrl: string | undefined): string | undefined {
    const isRelative = url.startsWith("./") || url.startsWith("../");
    if (!isRelative) {
        return url;
    }
    if (parentOriginUrl === undefined) {
        return undefined; // signals "unavailable" to the caller
    }
    return resolveRelativeSubmoduleUrl(url, parentOriginUrl);
}
```

### 3. URL → normalized identity

Handles three input forms:
- scp-style: `git@host:owner/repo.git` (no `://`, matches `user@host:path`)
- `ssh://git@host[:port]/owner/repo[.git]`
- `https://host[:port]/owner/repo[.git]`

```ts
const DEFAULT_PORTS_BY_SCHEME: Record<string, string> = { https: "443", http: "80", ssh: "22" };

function normalizeRepositoryIdentity(url: string): RepositoryIdentity | null {
    const scpMatch = !url.includes("://") && url.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);

    let host: string;
    let pathPortion: string;
    let scheme = "ssh"; // scp-style URLs are implicitly ssh
    let port: string | null = null;

    if (scpMatch) {
        host = scpMatch[1];
        pathPortion = scpMatch[2];
    } else {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return null;
        }
        scheme = parsed.protocol.replace(":", "");
        host = parsed.hostname;
        port = parsed.port || null;
        pathPortion = parsed.pathname.replace(/^\//, "");
    }

    pathPortion = pathPortion.replace(/\/+$/, "").replace(/\.git$/i, "");
    const segments = pathPortion.split("/").filter(Boolean);
    if (segments.length < 2) {
        return null;
    }

    const repository = segments[segments.length - 1];
    const owner = segments.slice(0, -1).join("/");

    const isNonDefaultPort = port !== null && port !== DEFAULT_PORTS_BY_SCHEME[scheme];
    const hostIdentity = isNonDefaultPort ? `${host}:${port}` : host;

    return {
        host: hostIdentity.toLowerCase(),
        owner: owner.toLowerCase(),
        repository: repository.toLowerCase(),
    };
}
```

Design note on ports: the identity has no separate `port` field. A
default port collapses into the bare host (matching the brief's "default
ports included" requirement). A non-default port is folded into the
`host` string (`host:port`) so two URLs on different nonstandard ports
are *not* treated as the same repository — no test in the brief requires
distinguishing nonstandard ports, so this is the smallest structure that
satisfies the stated requirement without adding a fourth identity field.

### 4. Identity comparison

```ts
function repositoryIdentitiesMatch(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
    return a.host === b.host && a.owner === b.owner && a.repository === b.repository;
}
```

### 5. Top-level entry point

```ts
export function resolveSubmoduleUpstreamIdentity(
    occurrences: SubmoduleOccurrence[]
): SubmoduleIdentityResolution {
    const resolvedUrls: string[] = [];

    for (const occurrence of occurrences) {
        if (occurrence.url === undefined) {
            return resolutionRequired("missing .gitmodules url entry", occurrences);
        }
        const fullUrl = resolveSubmoduleUrl(occurrence.url, occurrence.parentOriginUrl);
        if (fullUrl === undefined) {
            return resolutionRequired("relative submodule url has no parent origin to resolve against", occurrences);
        }
        resolvedUrls.push(fullUrl);
    }

    const identities = resolvedUrls.map(normalizeRepositoryIdentity);
    if (identities.some((identity) => identity === null)) {
        return resolutionRequired("submodule url could not be parsed into a repository identity", occurrences);
    }

    const [first, ...rest] = identities as RepositoryIdentity[];
    for (const identity of rest) {
        if (!repositoryIdentitiesMatch(first, identity)) {
            return resolutionRequired("submodule urls resolve to different repository identities", occurrences);
        }
    }

    return { status: "resolved", identity: first };
}

function resolutionRequired(reason: string, occurrences: SubmoduleOccurrence[]): SubmoduleIdentityResolution {
    return { status: "resolution-required", reason, occurrences };
}
```

If `scripts/resolutionRequests.ts` has an existing constructor, `resolutionRequired`
should call it and adapt its return value into the `resolution-required` branch,
rather than building the object literal shown here.

## Public exports from `scripts/submoduleUrlIdentity.ts`

- `SubmoduleOccurrence`, `RepositoryIdentity`, `SubmoduleIdentityResolution` (types)
- `resolveRelativeSubmoduleUrl`
- `normalizeRepositoryIdentity`
- `resolveSubmoduleUpstreamIdentity`

Keep `resolveSubmoduleUrl`, `repositoryIdentitiesMatch`, and
`resolutionRequired` module-private (not exported) — nothing outside this
module needs them yet, and this task adds no call sites.

## Tests — `tests/submoduleUrlIdentity.test.ts`

Follow strict TDD: write each test below first (red), then add just enough
of the functions above to pass it (green), in the order listed — each test
should require touching only the function(s) named. Use this repo's
existing test-runner style (see "Before writing any code"). Title each
test `test_<behavior_being_tested>`, with plain-English step comments in
the body per `~/.claude/guides/tdd.md`.

1. **test_relativeSubmoduleUrlResolvesAgainstParentOrigin**
   `resolveRelativeSubmoduleUrl("../tmux_lib.git", "https://example.com/group/parent.git")`
   → `"https://example.com/group/tmux_lib.git"`.
   Steps: parent origin is a `.git` URL two segments deep; relative URL
   walks up one directory; assert the resolved URL replaces only the
   last path segment, keeping `group/`.

2. **test_relativeSubmoduleUrlWithDotSlashResolvesInPlace**
   `resolveRelativeSubmoduleUrl("./sibling.git", "https://example.com/group/parent.git")`
   → `"https://example.com/group/sibling.git"`.

3. **test_relativeSubmoduleUrlWalksMultipleLevelsUp**
   `resolveRelativeSubmoduleUrl("../../other/repo.git", "https://example.com/a/b/parent.git")`
   → `"https://example.com/other/repo.git"`.

4. **test_relativeSubmoduleUrlResolvesAgainstScpStyleParentOrigin**
   Parent origin `"git@host:group/parent.git"`, relative `"../tmux_lib.git"`
   → `"git@host:tmux_lib.git"` (exercises the `:`-boundary branch, no `/`
   left before the last segment is stripped).

5. **test_scpSshAndHttpsUrlsNormalizeToSameIdentity**
   Three URLs — `"git@host:owner/repo.git"`, `"ssh://git@host/owner/repo"`,
   `"https://host/owner/repo.git"` — each passed to
   `normalizeRepositoryIdentity`; assert all three produce
   `{ host: "host", owner: "owner", repository: "repo" }`.

6. **test_differingHostDoesNotNormalizeToSameIdentity**
   `normalizeRepositoryIdentity("https://hostA/owner/repo.git")` vs.
   `normalizeRepositoryIdentity("https://hostB/owner/repo.git")` →
   assert `repositoryIdentitiesMatch` on the two results is `false`.
   (`repositoryIdentitiesMatch` is module-private; test this via
   `resolveSubmoduleUpstreamIdentity` returning `resolution-required` for
   two occurrences with these URLs and no `parentOriginUrl`, OR export
   `repositoryIdentitiesMatch` if this repo's test conventions require
   directly testing private helpers. Prefer testing through the public
   `resolveSubmoduleUpstreamIdentity` entry point.)

7. **test_differingOwnerDoesNotNormalizeToSameIdentity**
   Same shape as #6 but same host, different owner segment.

8. **test_caseDiffersButIdentityNormalizesTheSame**
   `"HTTPS://Host.Example.COM/Owner/Repo.GIT"` vs.
   `"https://host.example.com/owner/repo.git"` → same identity.

9. **test_trailingSlashAndDotGitSuffixNormalizeToSameIdentity**
   `"https://host/owner/repo/"` vs. `"https://host/owner/repo.git"` → same identity.

10. **test_defaultHttpsPortNormalizesToSameIdentity**
    `"https://host:443/owner/repo.git"` vs. `"https://host/owner/repo.git"` → same identity.

11. **test_defaultSshPortNormalizesToSameIdentity**
    `"ssh://git@host:22/owner/repo.git"` vs. `"git@host:owner/repo.git"` → same identity.

12. **test_nonDefaultPortDoesNotNormalizeToSameIdentity**
    `"https://host:8443/owner/repo.git"` vs. `"https://host/owner/repo.git"` → different identity.

13. **test_missingGitmodulesUrlProducesResolutionRequest**
    `resolveSubmoduleUpstreamIdentity([{ path: "lib/tmux", url: undefined, parentOriginUrl: "https://host/group/parent.git" }])`
    → `{ status: "resolution-required", reason: <mentions missing url>, occurrences: [...] }`.
    Assert `status` and that `occurrences` is the same input array (or
    equal by value) — do not over-assert on exact reason wording, only
    that it is a non-empty string.

14. **test_missingParentOriginProducesResolutionRequestForRelativeUrl**
    `resolveSubmoduleUpstreamIdentity([{ path: "lib/tmux", url: "../tmux_lib.git", parentOriginUrl: undefined }])`
    → `resolution-required`.

15. **test_absoluteUrlDoesNotRequireParentOrigin**
    `resolveSubmoduleUpstreamIdentity([{ path: "lib/tmux", url: "https://host/owner/tmux_lib.git", parentOriginUrl: undefined }])`
    → `status: "resolved"` (proves absolute URLs bypass the relative-resolution/parent-origin requirement).

16. **test_resolveSubmoduleUpstreamIdentityResolvesWhenAllOccurrencesAgree**
    Two occurrences of the same submodule seen from two different parent
    repos: one gives a relative URL resolved against its parent origin,
    the other gives an absolute URL in a different form (e.g. scp-style
    vs. https) — both normalize to the same identity. Assert
    `status: "resolved"` and the returned `identity` matches the expected
    `{ host, owner, repository }`.

17. **test_resolveSubmoduleUpstreamIdentityRequestsResolutionWhenOccurrencesDisagree**
    Two occurrences whose resolved URLs point at genuinely different
    owners. Assert `status: "resolution-required"` and that both original
    occurrences are present in the returned `occurrences` array (so a
    human/downstream consumer can see exactly what conflicted).

18. **test_unparseableUrlProducesResolutionRequestInsteadOfThrowing**
    An occurrence with `url: "not a url"` (fully absolute per the
    relative-prefix check, so it reaches `normalizeRepositoryIdentity` and
    returns `null`) → `resolveSubmoduleUpstreamIdentity` returns
    `resolution-required`, it must not throw.

## Order of implementation

Work top-down through the numbered test list — each test's function
already exists as pseudocode above, so "green" for each step is a direct
transcription, not new design. Do not implement `resolveSubmoduleUpstreamIdentity`
(tests 13–18) before `resolveRelativeSubmoduleUrl` and
`normalizeRepositoryIdentity` are both green (tests 1–12) — it composes them.

## Explicitly out of scope (do not add)

- No wiring into `repositoryDiscovery.ts` / `repositoryGraph.ts` or any
  other production call site — the brief states none exist yet.
- No support for `git://` or bare `http://` schemes, credential-embedded
  URLs (`https://user:pass@host/...`), or GitHub/GitLab-specific quirks
  beyond multi-segment owner paths (already handled generically by the
  "everything before the last path segment is the owner" rule).
- No caching, no network calls, no filesystem/`.gitmodules` file reading —
  this module takes already-extracted `{ url, parentOriginUrl }` pairs as
  plain data; wiring it to actual `.gitmodules` parsing is a later task.
