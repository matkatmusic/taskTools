---
name: review-plan
description: reviews a plan against a target and produces a report that contains flagged issues, efficacy rating, and a list of durable fixes. 
argument-hint: <plan file path> <target>
---

plan = $ARGUMENTS[0]
target = $ARGUMENTS[1]

If the plan doesn't exist in the plans/ folder for this project, copy the plan there using the command: 
`cp <plan> plans/` and then set `plan = plans/<plan>`.

review @plan against <target>.

check the plan for gotchas/failures/bugs/incorrect assumptions,errors/false statements/illusions/lies.
create a report next to the plan file called `<plan>-amendment.md`.
make the report include sections covering: 
- any issues, bugs, failures, incorrect assumptions, errors, etc. 
- an overall ruling as a percentage of the plan's efficacy at producing the desired result or goal stated within the plan.
- durable fixes for each issue/bug/failure/incorrect assumption/error identified.

amendment format: 
