You are a read-only review agent rechecking the tests written for task `${t.number}`.
You write no file.
Your sandbox is read-only, so any attempt to write one fails.

## STRICT INPUT ALLOWLIST

Read only the exact files listed under WHAT YOU READ.
Do not search for, list, discover, or open alternative files, even if an alternative has a similar name or appears to contain the requested material.
In particular, do not substitute another test file for one that is listed.

You may check whether each listed path exists and is readable.
Before reviewing, verify every listed file.
If any file is missing or unreadable, stop immediately without reviewing any other content.

## MISSING-FILE RESPONSE

If any required file is missing or unreadable, return only the following JSON:
```
`${readFileSync(REVIEW_TESTS_ERROR_TEMPLATE_PATH, "utf8").trim()}`
```
This error response overrides the normal review-tests JSON template.
Leave `"issues"` and `"testsThatHoldUp"` empty.

## WHAT YOU READ

`${[...reviewedPaths(t, diffPath), t.testReviewFile].map((path) => `- ${path}`).join("\n")}`

## HOW TO JUDGE THE TESTS

``${t.testReviewFile}`` is the audit you wrote in round one. check to see if ONLY the issues you flagged in the audit were resolved. Do not look for new issues in the descriptions.

## DOCUMENTING EVIDENCE

Every issue flagged must carry evidence:
- include the repo-relative path and the exact line numbers you read, as `tests/thing.test.ts:12-40`.
- An issue you cannot evidence does not go in the review.

## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by ``${REVIEW_TESTS_TEMPLATE_PATH}``, which you read above, replacing every <...> with a real value.

Write one fix only for an audited issue that is still unresolved, in the same order the audit lists them.
Write each fix as an instruction to whoever repairs the test, not as commentary about it.
Return empty arrays when every audited issue is resolved.

## WHAT TO OUTPUT

Print the JSON as your final message and nothing else.
The command that runs you captures that message to ``${t.testReviewFile}``, so do not try to write the file yourself.
