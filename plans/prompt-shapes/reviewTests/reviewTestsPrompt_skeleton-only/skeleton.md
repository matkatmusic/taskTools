`${spawnAgentHeader("review", true)}`

````sh
REVIEW_PROMPT=$(cat <<'REVIEWEOF'
`${reviewTestsQuestion(t, diffPath, preExistingTestFiles, "npm test", taskTests.output)}`
REVIEWEOF
)
REVIEW_FILE=`${t.testReviewFile}`
CODEX_LOG=`${codexLogFile()}`
`${codexExecCommand(REVIEW_TESTS_SCHEMA_PATH)}`
````

`${whatToReturnSection(`{ "reviewFile": "${t.testReviewFile}", "codexSucceeded": <true if the codex command above exited zero, else false> }`, "the path \`$REVIEW_FILE\` was set to (never its contents) and whether the codex command exited zero", "The next block reads codexSucceeded to decide whether to rule on the review or fall back to another reviewer.")}`