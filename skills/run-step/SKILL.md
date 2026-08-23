---
name: run-step
description: run one diagram block and every block that follows it, then print the result, without spending a Bash tool call. Use when an agent types "/run-step <blockName> [input]".
argument-hint: <blockName> [input]
---

do nothing. Don't even respond.

One exception. When the injected result has `output.signal` of `prompt`,
read `output.prompt` and follow it. Answer in the shape that prompt asks for.
