# State machine and setup

Shared by every pipeline skill. The calling skill defines two things this reference leaves as its own delta: **where the state root lives** (each pipeline derives `<root>` differently) and **the exact set of statuses and seed fields** it uses (each pipeline's phase-loop table and status list name these). Everything else, the bootstrap sequence, the mode reconcile, the job rename, and the single-mutator contract, is identical and lives here.

## Setup (run once at the top of every invocation)

1. **Parse the argument** as `<issue> [mode]`. `mode` is one of `auto`, `semi-auto`, or `manual`. If no mode word is given, default to `semi-auto` (but see step 4: a persisted mode wins for a resume). Reject any other mode word loudly. Merging a finished PR is a separate skill, `/merge-pr`, not a mode here.
2. **Derive the state root** as the calling skill specifies. If you are inside a git worktree, resolve to the canonical main-checkout name (via `git rev-parse --git-common-dir`) so all worktrees of one repo share one root. The issue folder is `<root>/<issue>/`; `state.json` and the phase artifacts are siblings inside it.
3. **Bootstrap the issue folder.** `mkdir -p` the issue folder if it does not exist. If `<root>/<issue>/state.json` does not exist, seed it with the calling skill's seed object (at minimum `{"status": "open", "mode": "<mode>", "branch": null, "prNumber": null, "qaVerdict": null, "pendingQuestion": null, "dependsOn": []}`, plus any extra field the skill names) with the mode from step 1. Never `git add` this folder or any file in it; it lives outside the repo tree by construction.
4. **Reconcile mode.** If `state.json` already existed and the caller passed no mode word, use the persisted `state.json.mode`. If the caller passed a mode word, write it into `state.json.mode` (a rerun may legitimately change the mode).
5. **Rename this background job** to a clean, issue-derived title so a wall of parallel pipeline runs is legible at a glance. Fetch the issue title (`gh issue view <issue> --json title --jq .title` for a GitHub issue; the first non-empty line of `<root>/<id>/issue.md`, minus a leading `# `, for a local issue), then shell out to the rename script:
   ```
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-rename-job.sh" <issue> "<title>"
   ```
   The script writes `#<issue> <slug>` (a numeric issue) or `<id> <slug>` (a local issue) into the running job's title and pins it. It is a silent no-op in a foreground run (no background job to rename) and a soft step overall: a non-zero exit or an unfetchable title is a warning, not a pipeline failure, so never let it block the phase loop.

## The single validated status mutator

The **only** way you change `state.json.status` is by shelling out to the transition script. It ships with the plugin (you never copy it into the target repo); reference it by the plugin-root path variable. You never write the `status` field with your own `jq`/`Write`:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-transition.sh" <root> <issue> <to-status>
```

- Three arguments, in order: the state root `<root>` (from setup step 2), the issue, and the **bare** target status (no `status:` prefix), e.g. `spec-ready`, not `status:spec-ready`.
- The script reads the current status from `state.json` itself and validates the edge; you only name the target.
- Check the exit code. A non-zero exit is a hard error (an illegal transition, or a missing state file): surface it, do not swallow it, do not retry with a different target to force it through.
- You **do** directly write the other `state.json` fields (`mode`, `branch`, `prNumber`, `qaVerdict`, `pendingQuestion`, `dependsOn`, and any extra field the calling skill names) with `jq`/an edit, since those are not the state machine and have no transition rules. Only `status` is gated.

The calling skill's status list and phase-loop table name the exact statuses it emits; the transition script's edge table is the single source of truth for which edges are legal.
