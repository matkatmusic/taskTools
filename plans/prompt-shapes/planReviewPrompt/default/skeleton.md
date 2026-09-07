`${spawnAgentHeader("review", true)}`

````sh
`${createCodexShellInvocation(t)}`
````

`${whatToReturnSection(`{ "reviewFile": "${t.reviewOutputFile}" }`, "the path \`$REVIEW_FILE\` was set to, never its contents", "The next block reads the file and fails loudly when it is missing or unusable.")}`
