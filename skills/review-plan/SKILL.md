---
name: review-plan
description: reviews a plan against a target and produces a report that contains flagged issues, efficacy rating, and a list of durable fixes. 
argument-hint: <plan file path> <target>
---

- plan file: $ARGUMENTS[0]
- target: !`echo '$ARGUMENTS' | cut -d' ' -f2-`

If that plan file is not already inside this project's `plans/` folder, copy it there
(`cp $ARGUMENTS[0] plans/`) and review the copy — every path below then refers to the copy.

review $ARGUMENTS[0] against !`echo '$ARGUMENTS' | cut -d' ' -f2-`.

check the plan for gotchas/failures/bugs/incorrect assumptions,errors/false statements/illusions/lies.
create a report next to the plan file called `<plan>-amendment.md`.
make the report include sections covering: 
- any issues, bugs, failures, incorrect assumptions, errors, etc. 
- an overall ruling as a percentage of the plan's efficacy at producing the desired result or goal stated within the plan.
- durable fixes for each issue/bug/failure/incorrect assumption/error identified.

amendment format: 
