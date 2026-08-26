// Prompt sections repeated word-for-word across agent roles. Imports nothing, so no prompt file gains a cycle.

// Every agent works in a worktree that shadows the ambient checkout, so the root is always named.
export const absolutePathsSection = (root: string) => `## ALWAYS USE ABSOLUTE PATHS

For every filesystem tool call, use the absolute path under \`${root}\`.
Never resolve a repo-relative path against your ambient working directory, and never read or edit the same relative path in another checkout.
Every shell command must run inside \`${root}\`.`;
