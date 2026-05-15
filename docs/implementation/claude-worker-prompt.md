# Claude Worker Prompt

Use this prompt for each implementation task. Replace the task ID and title before sending it to the worker.

```text
You are implementing Polaris, an internal event infrastructure platform.

Before coding, read:
- /Users/cassio/src/polaris/docs/README.md
- /Users/cassio/src/polaris/docs/instructions/claude.md
- /Users/cassio/src/polaris/docs/implementation/README.md
- /Users/cassio/src/polaris/agents/pm/README.md (file-backed kanban; run `python3 agents/pm/bin/cards.py report` for board state)
- /Users/cassio/src/polaris/docs/implementation/delivery-roadmap.md
- /Users/cassio/src/polaris/docs/implementation/coverage-matrix.md
- the task card assigned below
- the architecture docs listed in that task card

Assigned task:
- TASK_ID: <replace>
- TASK_TITLE: <replace>
- TASK_FILE: <replace>
- EXPECTED_BASE_COMMITS: <replace with the most recent merged task IDs the orchestrator says you should branch from, in order; e.g. "P0-001, P0-002, P1-001, P1-003">

Verify your base before working — THIS IS STEP ZERO, NON-OPTIONAL:
1. Run `git log --oneline -10` and confirm each EXPECTED_BASE_COMMITS entry is present.
2. If any expected commit is missing, your worktree branched from a stale base. Run `git rebase main` to bring your worktree branch up to date. `main` is a peer branch inside the worktree; the rebase brings in any commits you are missing.
3. Re-run `git log --oneline -10` to confirm the rebase succeeded. Report the result in your final summary so the integration step has visibility.
4. After a rebase, re-check that the workspace `.gitignore` covers `node_modules/`, `dist/`, `coverage/`, `*.tsbuildinfo`. These should be ignored by repo policy; if they are not, stop and report the missing patterns.

If you skip the verify-your-base step and silently work against a stale base, the orchestrator will detect it at integration (the worktree HEAD will diverge from main) and have to redo your work. Do not skip. State in your final summary: `Rebase: not needed` OR `Rebase: applied, brought in <list of commits>`.

Orchestrator-side check: before any `git merge --squash <worktree-branch>`, the orchestrator runs `git -C <worktree-path> log --oneline -1` and confirms the HEAD matches the latest main commit. Worktrees that diverge are flagged loudly so the worker output can be cleaned up (root pollution dropped, package directory kept, missing rebase noted in the integration commit). Workers that DO follow the verify-your-base step save the orchestrator that cleanup pass.

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
1. Verify your base (above), rebasing onto main if needed.
2. Inspect the repo.
3. Restate the task ID and write scope.
4. Implement the task.
5. Run the task's requested checks where possible.
6. Update the task handoff section if instructed.
7. Return a final summary with:
   - whether a rebase was needed and what it brought in
   - files changed (source files only; not node_modules, dist, coverage, .vitest, *.tsbuildinfo)
   - commands run
   - checks passed/failed
   - gaps or follow-up tasks

Do not commit unless explicitly asked. The orchestrator stages and commits your work explicitly at integration time; never run `git add -A` or `git commit` from your worktree.
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
