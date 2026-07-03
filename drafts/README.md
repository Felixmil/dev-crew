# drafts/ (inactive)

Nothing in this folder is active. It is deliberately outside the plugin's
discovered directories (`agents/`, `skills/`, `workflows/`), so
skill/plugin discovery never scans it and none of these can be invoked.
It is kept in the repo as a reference and a reactivation path, not as
shipped functionality.

Both pipelines are now driven by **in-session skills**, not by dynamic
Workflow scripts. The two Workflow versions were built, tested, and then
drafted (deactivated) in favor of the skills. This is where they live.

## What's here

### The file-based pipeline as a dynamic workflow

- `file-pipeline.js` — the Workflow engine (was `workflows/file-pipeline.js`).
- `file-pipeline-workflow/` — the thin session-shell skill that drove it
  (was `skills/file-pipeline-workflow/`). Moving it out of `skills/` is
  what deactivates the `/file-pipeline-workflow` command.

Superseded by the active `run-pipeline` skill. Design recorded in
`specs/file-pipeline-workflow.md`.

### The gh-posting pipeline as a dynamic workflow

- `gh-pipeline.js` — the Workflow that drove spec -> plan -> build -> QA
  with state in GitHub `status:*` labels and artifacts posted to the
  issue/PR threads (was `workflows/gh-pipeline.js`).

Superseded by the active `run-pipeline-gh` skill, which does the same
GitHub posting but in-session, gating via inline `AskUserQuestion`.

### The GitHub-label state mutator

- `status-transition.sh` — moved the issue's `status:*` label through the
  transition table (was `.claude/scripts/status-transition.sh`).

Drafted because the gh-posting pipeline no longer stores state in labels:
`run-pipeline-gh` now keeps state in the local `state.json` (via the
active `.claude/scripts/issue-state-transition.sh`), so it works in repos
where `status:*` labels are unavailable or the user cannot create them.
This label mutator is kept only as a reference / reactivation path.

## What is still active

- `skills/run-pipeline/` — the in-session **file-based** pipeline.
- `skills/run-pipeline-gh/` — the in-session **gh-posting** pipeline.
- the five agents in `agents/` (`spec-writer`, `planner`, `builder`,
  `reviewer`, `conflict-resolver`). Both skills drive the same crew.
- `.claude/scripts/issue-state-transition.sh` — the **only** active
  transition script. Both pipelines use it: state lives in the local
  `state.json` for both, with no GitHub labels anywhere. (The label-based
  `status-transition.sh` is drafted here, above.)

None of these are part of this draft; drafting the workflows and the label
mutator did not touch them.

## To reactivate a workflow variant

Move the entries back into the discovered directories, e.g.:

```
# file-based dynamic workflow
mv drafts/file-pipeline.js        workflows/file-pipeline.js
mv drafts/file-pipeline-workflow  skills/file-pipeline-workflow

# gh-posting dynamic workflow
mv drafts/gh-pipeline.js          workflows/gh-pipeline.js
```

and copy the `.js` into a target repo's `.claude/workflows/` (workflow
scripts are copied per repo). Note the drafted workflows still reference
the pre-unification behavior in places; reconcile them with the current
lean, file-based agents before relying on them.
