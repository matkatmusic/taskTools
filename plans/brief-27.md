# Task 27: Read-only startup discovery and test-hook confirmation before any mutation

Phase 4 of the recursive repository-discovery redesign.

Create scripts/runStartup.ts and restructure startup so command interpolation performs only read-only task and blocker discovery — no worktrees, no branches, no commits. Before any mutating preparation step, require confirmation that the copied taskTools test hook from scripts/relatedTests.ts is enabled, and register that hook's entry point in hooks/hooks.json (taskTools registers hooks in hooks/hooks.json, not in any settings.json).

No semantic commit, remote push, integration merge, base update, or task archival may occur at startup under any code path.

Tests: startup with the hook disabled stops before creating a worktree or branch; hook confirmation is verified to precede every mutating preparation step; the read-only discovery path performs no writes to the repository; hooks/hooks.json registration is asserted to load the copied entry point.

### scripts/runStartup.ts

(missing: file not found on disk)

### hooks/hooks.json

```
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/viewTaskHook.ts\""
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/turn-modified-flag.ts\" 2>/dev/null || true"
          },
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/reflow-comments-post.ts\"",
            "statusMessage": "Reflowing wrapped comments..."
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/stage-and-summarize-stop.ts\"",
            "statusMessage": "Checking comments and unstaged work..."
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/stage-and-summarize-stop.ts\"",
            "statusMessage": "Checking comments and unstaged work..."
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node --no-inspect \"${CLAUDE_PLUGIN_ROOT}/scripts/session-end-cleanup.ts\" 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}

```

### tests/runStartup.test.ts

(missing: file not found on disk)
