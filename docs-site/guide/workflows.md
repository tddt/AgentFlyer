# Workflows

Workflows are how AgentFlyer turns one-off agent turns into repeatable operator processes.

## What the workflow runtime gives you

- ordered execution steps
- branching and conditional paths
- transforms between stages
- super-node coordination patterns
- execution history and resumable status
- deliverable-aware output handling

## When to use workflows

Use chat when the task is exploratory.

Use a workflow when the task becomes:

- repeatable
- multi-stage
- reviewable by operators
- schedulable
- worth storing as an execution artifact

## Common workflow shapes

| Pattern | Example |
|---|---|
| Collect -> analyze -> publish | gather sources, synthesize, create final deliverable |
| Debate -> review -> decide | multiple specialist outputs, adjudication, decision record |
| Intake -> route -> execute | turn inbound requests into agent-targeted execution |
| Scheduled automation | timed job triggers workflow and stores deliverables |

## Super-node role

Super nodes are useful when a single step should represent higher-order coordination instead of one narrow agent turn. They are a good fit for collection, comparison, review, and arbitration patterns.

## Operator value

Workflows matter because they move the runtime from reactive chat to operational process:

- history becomes inspectable
- failures become diagnosable
- outputs become deliverables
- schedules become safe to attach

## Related pages

- [Agents](./agents)
- [Memory](./memory)
- [Deployment](./deployment)