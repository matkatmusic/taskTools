# Task 45: Manifest bootstrap: produce a RepositoryManifest from a bare repoRoot

Nothing in production can currently obtain a manifest. discoverRepositoryTree(rootPath, manifest) takes a DiscoveryManifest as input and fills it in rather than building one, and readRepositoryManifest and writeRepositoryManifest are called by nothing in scripts/ outside their own file — only tests construct manifests, by hand. prepareTasks.ts starts from a bare repoRoot, so every graph consumer (discoverRepositoryTree, buildCanonicalTaskGroups, setUpOperationBranches) has no way to be called in production.

Add scripts/manifestBootstrap.ts exporting a function that takes a repoRoot, builds an empty DiscoveryManifest at REPOSITORY_MANIFEST_VERSION with an empty ResolutionManifest, runs discoverRepositoryTree, and returns either the resolved occurrence graph or a non-interactive refusal that names every ResolutionRequest with its reason so a CLI caller can refuse cleanly.

Do not prompt interactively and do not persist the manifest to disk — keep it in memory until a caller needs persistence.

Tests: a repository with no submodules bootstraps to a resolved graph holding one occurrence for the root; a repository whose submodule sits at its recorded gitlink OID resolves both occurrences; an unresolvable gitlink returns the refusal naming each request and its reason; bootstrap performs no git checkout and creates no branch on any path.

### scripts/manifestBootstrap.ts

(missing: file not found on disk)

### tests/manifestBootstrap.test.ts

(missing: file not found on disk)
