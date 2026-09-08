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

`${reviewAnswerSection(t.testReviewFile)}`