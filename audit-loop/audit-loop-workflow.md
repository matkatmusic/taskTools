# Audit loop workflow

Agents never commit in the active worktree. Every commit below is performed by a human or external mechanism after reviewing the staged handoff.

## Start

1. Complete and externally commit the implementation being audited.
2. Codex audits that revision against its specification and records findings in `audit-loop/codex-audit.json` using `audit-loop/codex-audit-schema.md`.
3. Externally commit the audit record before beginning the repair loop.

## Repair loop

1. Select one finding, or an inseparable batch, from `audit-loop/codex-audit.json`.
2. Run `audit-loop/sonnet-implementation-prompt.md`. Sonnet fixes the selected findings and stages only implementation and test changes.
3. Run `audit-loop/codex-review-prompt.md`. Codex reviews only the staged changes against the selected findings.
4. If accepted, Codex removes the selected findings and leaves the implementation, tests, and audit update staged together.
5. If rejected, Codex unstages the implementation, updates the selected findings, and leaves only the audit update staged.
6. Stop for external review and commit of the staged handoff.

An accepted implementation and its audit removal must be committed together. A rejected implementation is never committed; it remains unstaged for the next Sonnet repair.

## Close

1. After an accepted batch is externally committed, invoke the **Audit refresh** section of `audit-loop/codex-review-prompt.md` against the new `HEAD`.
2. If Codex stages an audit refresh, stop for external review and commit.
3. If findings remain, return to the repair loop.
4. If `audit-loop/codex-audit.json` has no findings, the audit loop is complete.
