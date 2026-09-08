# Phase 11 audit

Review target: staged tree `4c9fc560c435cf71d80517b5fd1419820d4f614d`, compared with
Phase 11 of `plans/tackle-tasks-v1_5-plan.md`, the repository-wide input rule in that
plan, and sections 4, 5, 7, and the boundary clarifications in
`plans/workflow-only-context-injection.md`.

## Findings

### 1. The emitted `projectRoot` is the ambient working directory, not the repository root

The plan says scripts must not depend on the agent's working directory, requires
`projectRoot` to be explicit and absolute, and says `SkillBodyEmitter` accepts only the
invocation-varying argument string, never a path. The implementation instead adds a
`projectRoot` parameter to `skillBody()` and passes `process.cwd()` from the CLI
(`scripts/tackle-tasks/SkillBodyEmitter.ts:17-22,64-65`). The corresponding test makes the
same assumption and pins `/tmp` as the emitted project root
(`tests/tackle-tasks/SkillBodyEmitter.test.ts:133-140`).

This is not only a signature mismatch. Invoking the skill from this repository's `scripts/`
directory emits
`/Users/matkatmusicllc/Programming/taskTools-86/scripts` as `projectRoot`. The resolver
returns that value verbatim, and every task workflow is explicitly told to keep using it.
Later, `sourceRepoLock.ts` builds its durable lock at
`join(projectRoot, ".git", ...)` (`scripts/tackle-tasks/sourceRepoLock.ts:30-39`), so that
normal nested-directory invocation targets the nonexistent `scripts/.git` instead of the
source repository's real Git directory. The workflow can get through task-file reads that
walk upward, then fail when it reaches the source-lock/merge tail; other consumers also
receive a subdirectory where the contract promises the source root.

Make the resolver workflow return the canonical source-repository root regardless of the
invoking shell's current subdirectory, and remove the path parameter from the exported
`skillBody` surface so its only input is `argsValue`. The absolute target root may be
supplied explicitly at the orchestration boundary or normalized inside the isolated
resolver before `sourceBranch` is read, but the raw `process.cwd()` value must not become
the downstream `projectRoot`. Add an integration test that invokes the real skill emitter
from a nested directory, runs the resolver boundary, and proves the returned root is the
repository top level and that the source-lock path is under that repository's actual Git
directory. Keep the installed-plugin directory distinct from the target repository in the
fixture.

### 2. The skill body leaks the internal resolver script name and path

Phase 11 retains the v1 boundary requirement that no internal script name appears in the
generated skill body. The staged emitter resolves `resolveTaskRun.ts` and places it directly
in the workflow arguments (`scripts/tackle-tasks/SkillBodyEmitter.ts:12,19-22`), so the main
agent receives both the `resolveTaskRunPath` key and the absolute internal script path before
the resolver workflow boundary is crossed.

The new test titled `test_skillBody_namesNoDataScriptAndNoTaskFile` does not enforce the new
chain: it rejects four older script names but never rejects `resolveTaskRun.ts`
(`tests/tackle-tasks/SkillBodyEmitter.test.ts:44-54`). The later workflow test only searches
the workflow source for `agent(` and a heredoc marker, so the required no-leak behavior can
regress while every test remains green.

Keep the emitted resolver declaration limited to the resolver workflow and generic,
boundary-safe paths (for example the already-resolved scripts directory); derive the
`resolveTaskRun.ts` command inside the resolver workflow's `agent(...)` side of the boundary
instead of naming that data script in `skillBody` output. Add a direct assertion that the
generated body contains neither `resolveTaskRun.ts` nor a `resolveTaskRunPath` field, plus a
runtime workflow test proving the resolver script is first named inside the agent prompt,
the schema-limited result is passed through, and the three-attempt null guard still applies.

## Verification performed

- Frozen staged tree: `4c9fc560c435cf71d80517b5fd1419820d4f614d`.
- `git diff --cached --check` — passed.
- `rg -n 'execFileSync|spawn|from "\.' scripts/tackle-tasks/SkillBodyEmitter.ts` — zero hits.
- Focused Phase 11 and compatibility suites — 75 passed, 0 failed.
- `npm test` — 1,890 passed, 0 failed.
- Real nested-directory emitter invocation — reproduced a resolver declaration whose
  `projectRoot` is the `scripts/` subdirectory and whose main-context arguments expose the
  absolute `resolveTaskRun.ts` path.

The green suite does not resolve these findings because its project-root test explicitly
asserts the ambient-CWD behavior, and its no-data-script assertion omits the new resolver
script.
