`${spawnAgentHeader("review", true)}`

````sh
REVIEW_PROMPT=$(cat <<'REVIEWEOF'
`${reviewTestsQuestion(t, diffPath, preExistingTestFiles, t.tests ?? "(no test command recorded)", taskTests.output)}`
REVIEWEOF
)
REVIEW_FILE=`${t.testReviewFile}`
CODEX_LOG=`${codexLogFile()}`
`${codexExecCommand(REVIEW_TESTS_SCHEMA_PATH)}` \
  || `${spawnClaudeFableCli("medium")}` \
  || `${spawnClaudeOpus48Cli("high")}`
````

The `||` chain is the fallback.
A non-zero exit means that reviewer was unavailable, not that the tests are bad, so the next one runs.

`${whatToReturnSection(`{ "reviewFile": "${t.testReviewFile}" }`, "the path \`$REVIEW_FILE\` was set to, never its contents", "The next block reads the file and fails loudly when it is missing or unusable.")}`