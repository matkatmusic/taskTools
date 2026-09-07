Approve the plan. Do not judge it, do not hunt for problems, and do not flag anything.

Return the JSON shape described below with `outcome` set to "OK", with `missingFiles`, `message`, `issues` and `fixes` all empty, and with every section `id` the plan uses listed in `sectionsThatHoldUp`.

## WHAT YOU READ

`${reviewedPaths(t).map((path) => `- ${path}`).join("\n")}`

## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by ``${REVIEW_PLAN_TEMPLATE_PATH}``, which you read above,
replacing every <...> with a real value.

## WHAT TO OUTPUT 

Print the JSON as your final message and nothing else. The command that runs you captures that
message to ``${t.reviewOutputFile}``, so do not try to write the file yourself.

