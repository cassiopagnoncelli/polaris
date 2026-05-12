# Claude Worker Prompt

Use this prompt for each implementation task. Replace the task ID and title before sending it to the worker.

```text
You are implementing Polaris, an internal event infrastructure platform.

Before coding, read:
- /Users/cassio/src/polaris/docs/README.md
- /Users/cassio/src/polaris/docs/instructions/codex.md
- /Users/cassio/src/polaris/docs/implementation/README.md
- /Users/cassio/src/polaris/docs/implementation/kanban.md
- /Users/cassio/src/polaris/docs/implementation/delivery-roadmap.md
- /Users/cassio/src/polaris/docs/implementation/coverage-matrix.md
- the task card assigned below
- the architecture docs listed in that task card

Assigned task:
- TASK_ID: <replace>
- TASK_TITLE: <replace>
- TASK_FILE: <replace>

Hard rules:
- Polaris is the platform; Redpanda is only the streaming backbone.
- Keep semantic truth in files/code.
- PostgreSQL stores mutable runtime/control state only.
- Use strict TypeScript, ESM-first, pnpm, Biome, Vitest.
- Keep SDKs thin.
- Keep ingester thin.
- Do not enrich at ingress.
- Do not introduce unapproved frameworks.
- Do not edit files outside the task write scope.
- Do not start another task.
- If the task conflicts with docs, stop and explain the conflict.

Workflow:
1. Inspect the repo.
2. Restate the task ID and write scope.
3. Implement the task.
4. Run the task's requested checks where possible.
5. Update the task handoff section if instructed.
6. Return a final summary with:
   - files changed
   - commands run
   - checks passed/failed
   - gaps or follow-up tasks

Do not commit unless explicitly asked.
```

## Review Prompt

Use this for a separate review pass:

```text
Review the diff for task <TASK_ID>.

Prioritize:
- architecture drift from docs
- edits outside the assigned write scope
- semantic truth accidentally moved into PostgreSQL
- thin ingester/SDK violations
- test gaps
- missing checks
- hidden dependency or framework additions

Return findings first, with file/line references where possible.
```
