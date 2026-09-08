Approve the plan.
Do not judge the plan.
Do not hunt for problems in the plan.
Do not flag anything in the plan.

Return the JSON shape described under **WHAT YOU, THE REVIEWING AGENT, RETURNS** below.
Set `outcome` to `"OK"`.
Leave `missingFiles` empty.
Leave `message` empty.
Leave `issues` empty.
Leave `fixes` empty.
List every section `id` the plan uses in `sectionsThatHoldUp`.

## WHAT YOU, THE REVIEWING AGENT, RETURNS

Return only JSON in the shape given by ``${REVIEW_PLAN_TEMPLATE_PATH}``, replacing every <...> with a real value.

## WHAT TO OUTPUT

Print the JSON as your final message and nothing else.
The command that runs you captures that message to ``${t.reviewOutputFile}``.
Do not try to write the file yourself.
