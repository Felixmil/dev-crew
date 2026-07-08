---
name: debug-pipeline
description: Drives one bug (a GitHub issue number, or a local L-prefixed issue) through investigate -> plan -> build -> QA, keeping the four artifacts and the state machine on the local filesystem under <repo>.issues/<issue>/ and all human interaction inline in this session. It is the bug counterpart to /run-pipeline: the spec phase is replaced by an investigate phase that reproduces and root-causes the bug, and QA additionally confirms a regression test covers the cited root cause. The issue is the input; a pull request is the ship channel; nothing is posted to the issue thread. Use when the user says "debug N", "run the debug pipeline on N", "investigate and fix bug N", passes a mode (auto/semi-auto/manual), or invokes /debug-pipeline with an issue number.
---

# Bug pipeline

You drive one bug issue through investigate -> plan -> build -> QA. This
is the bug counterpart to `/run-pipeline`: the spec phase is replaced by
an **investigate** phase that reproduces the bug and traces it to its root
cause, and QA additionally confirms a regression test covers that root
cause so the bug cannot silently return. Everything
else, the state machine, the modes, the resumable question flow, the
filesystem layout, is identical to `/run-pipeline`.

You run in this session's own context, so you own every `AskUserQuestion`
and every file read/write directly; you spawn the four file-writing
subagents for the heavy per-phase reasoning and hand each one concrete
filesystem paths. The four artifacts (`investigation.md`, `plan.md`,
`build.md`, `qa.md`), the state (`state.json`), and every human question
live on the local filesystem and in this session. The GitHub issue is
only the input; a pull request is only the ship channel. You never post a
comment to the issue thread, and you never add a bookkeeping comment to
the pull request.

## Mission

Take the bug from wherever `state.json` says it is to the next resting
point, writing each phase's artifact to disk, advancing the state only
through the single validated transition script, and surfacing every
question inline in a way that survives the session being killed. Where
you are is always read from `state.json`, never from what you remember
of this conversation. The investigate phase may conclude the report is
not a bug and stop the pipeline early.

## Setup (run once at the top of every invocation)

1. **Parse the argument** as `<issue> [mode]`. `mode` is one of `auto`,
   `semi-auto`, or `manual`. If no mode word is given, default to
   `semi-auto` (but see step 4: a persisted mode wins for a resume).
   Reject any other mode word loudly. (Merging a finished PR is a
   separate skill, `/merge-pr`, not a mode here.)
   - **Local issues.** An id starting with `L` (e.g. `L3`) is a **local
     issue**: it has no GitHub issue, its description lives in
     `<root>/<id>/issue.md` (created by the create-local-issue skill), and
     it is driven exactly like a GitHub issue except for three things,
     applied throughout this skill: (a) wherever you would read the issue
     with `gh issue view`, instead read `<root>/<id>/issue.md`; (b) the
     transition script already treats a local id as non-task and does no
     `gh` call; (c) the build phase opens a PR that references the local
     id in text rather than `Closes #N` (there is no GitHub issue to
     close), and the linked PR is found by branch, not by a `Closes`
     link (see Finding the linked PR). Everything else (state.json, the
     four artifacts, modes, gates, resumability) is identical.
2. **Derive the state root from git**, not from a hardcoded path:
   - Run `git rev-parse --show-toplevel` to get the repo's working tree
     root (an absolute path). Call its basename `<repo>` and its parent
     directory `<parent>`.
   - The state root is `<parent>/<repo>.issues`. Example: a repo at
     `~/Code/esqlabsR` gives a state root of `~/Code/esqlabsR.issues`.
   - The issue folder is `<root>/<issue>/`. The four artifacts and
     `state.json` are siblings inside it. This is the same root
     `/run-pipeline` uses; a bug and a feature issue share one state
     root, one archive, and one `dependsOn` space.
   - If you are inside a git worktree, `git rev-parse --show-toplevel`
     still returns this worktree's root; use `git rev-parse
     --git-common-dir` and resolve to the main checkout's directory name
     if you need the canonical repo name, so all worktrees of one repo
     share one `<repo>.issues` root.
3. **Bootstrap the issue folder.** First check whether this issue is
   already **archived**: a merged issue's folder is moved to
   `<root>/archive/<issue>/` by the `/merge-pr` skill. If
   `<root>/archive/<issue>/` exists, the issue is closed and shipped, do
   not re-bootstrap an empty active folder; tell the user it is already
   merged and archived and stop (unless they explicitly want to re-open
   it, in which case they should move it back out of `archive/`
   themselves). Otherwise, create `<root>/<issue>/` if it does not exist
   (`mkdir -p`). If `<root>/<issue>/state.json` does not exist, seed it
   with `{"status": "open", "mode": "<mode>", "branch": null,
   "prNumber": null, "qaVerdict": null, "investigationVerdict": null,
   "pendingQuestion": null, "dependsOn": []}` (the mode from step 1).
   Never `git add` this
   folder or any file in it; it lives outside the repo tree by
   construction.
4. **Reconcile mode.** If `state.json` already existed and the caller
   passed no mode word, use the persisted `state.json.mode`. If the
   caller passed a mode word, write it into `state.json.mode` (a rerun
   may legitimately change the mode).
5. **Rename this background job** to a clean, issue-derived title so a
   wall of parallel pipeline runs is legible at a glance. Fetch the issue
   title (`gh issue view <issue> --json title --jq .title` for a GitHub
   issue; the first non-empty line of `<root>/<id>/issue.md`, minus a
   leading `# `, for a local issue), then shell out to the rename script:
   ```
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-rename-job.sh" <issue> "<title>"
   ```
   The script writes `#<issue> <slug>` (a numeric issue) or `<id> <slug>`
   (a local issue) into the running job's title and pins it. It is a
   silent no-op in a foreground run (no background job to rename) and a
   soft step overall: a non-zero exit or an unfetchable title is a
   warning, not a pipeline failure, so never let it block the phase loop.

## Resume a pending question first (before any phase)

Immediately after loading `state.json`, before touching any phase:

- If `state.json.pendingQuestion !== null`, **re-ask that exact
  question first**. Rebuild the `AskUserQuestion` prompt from the
  persisted `phase`, `question`, `options`, and `recommendedDefault`
  (recommended option first). Do not print any context as prose before
  the call; everything the human needs is inside the question and option
  text.
- On the answer: **clear `pendingQuestion` to `null`** in `state.json`,
  then route the answer exactly as if it had just been raised (re-invoke
  the phase agent with the answer folded into its instructions, or take
  the gate's approve/revise branch, or the dependency's proceed/wait
  branch, depending on the persisted `phase`). Then continue the phase
  loop.

A killed, slept, or closed session therefore loses nothing: the question
survives in `state.json`, no artifact was written for it, and this
re-ask is the recovery path.

## The phase loop

Read `state.json.status` and drive the phase whose entry status matches.
The phases and their transition edges (all applied only through the
transition script, see below):

| Phase | Entry status | Agent | On success -> |
| --- | --- | --- | --- |
| investigate | `open` | `dev-crew:investigator` | `investigated` (bug-confirmed) or `not-a-bug` (terminal early exit) |
| plan  | `investigated` | `dev-crew:planner` | `ready-for-dev` |
| build | `ready-for-dev`, `in-progress`, `blocked` | `dev-crew:builder` | first `in-progress`, then `ai-review` |
| qa    | `ai-review` | `dev-crew:reviewer` (bug-aware) | `human-review` (approved) or `in-progress` (rejected) |

Every bug runs the full investigate -> plan -> build -> QA path, except
that the investigate phase may conclude the report is not a real bug and
stop the pipeline at the terminal `not-a-bug` status before plan. The
transition script has no `open -> in-progress` fast-path edge, so an
investigation is always produced first.

For each phase, in order:

1. **Compute the artifact path(s)** as absolute paths:
   `<root>/<issue>/investigation.md`, `.../plan.md`, `.../build.md`,
   `.../qa.md`.
2. **Resolve dependency read-paths** (see the dependsOn section). Pass
   depended-on issues' `spec.md`/`investigation.md`/`plan.md` paths as
   read-only context. Pass no other-issue path when `dependsOn` is empty.
3. **Invoke the phase agent** with a `schema` forcing the structured
   return object (so the agent returns the object, not prose). In the
   prompt, hand it: the issue number, the exact absolute path to write
   its artifact to, the read-only paths (this issue's upstream artifacts
   and any dependency artifacts), and, in `auto` mode, the instruction
   to adopt its own recommended default on any ambiguity and record the
   decision in the artifact (so it returns `done`, never
   `clarification-needed`).
   - **The plan, build, and QA agents take `investigation.md` where they
     would normally take `spec.md`.** The planner is handed
     `investigation.md` as its input document; the builder is handed
     `investigation.md` and `plan.md`; the reviewer is handed
     `investigation.md` and `plan.md`. Tell each in the prompt that this
     document is a bug investigation (reproduction, root cause, blast
     radius, proposed regression test), not a feature spec, so it plans,
     builds, and reviews the fix against the diagnosis. The agents read
     whatever path they are handed; only the prompt framing differs.
4. **On a `clarification-needed` return** (only possible in
   `semi-auto`/`manual`): follow the "Raising a question" procedure
   below, then re-invoke this same phase agent with the answer folded
   into its instructions. The agent writes the artifact only after the
   answer is in hand.
5. **On a `done` return**: read the artifact back from disk to confirm
   it exists and is non-empty (never trust the agent's summary that it
   wrote the file). For the investigate phase, parse the trailing
   `INVESTIGATION-VERDICT:` line from `investigation.md` itself (see the
   Investigate phase specifics). For QA, parse the trailing line matching
   `QA-VERDICT:` from `qa.md` itself (it is an HTML comment, `<!--
   QA-VERDICT: approved -->` / `<!-- QA-VERDICT: rejected -->`; read the
   verdict word out of the last such line) and record it in
   `state.json.qaVerdict`.
6. **Artifact-approval gate** (see the modes section): in `manual` mode,
   stop for an approve/revise decision before advancing; in
   `auto`/`semi-auto`, advance immediately.
7. **Advance the status** by shelling out to the transition script (see
   below). Then re-read `state.json.status` and continue to the next
   phase.

### Investigate phase specifics

- After the investigator returns `done`, read `investigation.md` back and
  parse the last `INVESTIGATION-VERDICT:` line (mirroring the QA-verdict
  read). Trust the file, not the agent's return. A missing or malformed
  final line reads as `cannot-reproduce` (the conservative early exit,
  never `bug-confirmed`, so a garbled verdict never silently drives a
  fix). Record the parsed verdict in `state.json.investigationVerdict` as
  a convenience field (it is not the gated `status`).
- **`bug-confirmed`**: this is a real bug. Transition `open ->
  investigated` and continue to the plan phase. In `manual` mode, hit the
  investigate approval gate first (`open -> investigate-awaiting-approval`,
  then on approve `-> investigated`), exactly as the spec gate works.
- **`not-a-bug` / `cannot-reproduce` / `works-as-intended`**: this is the
  early exit. Surface the finding to the user inline (the summary and the
  reason, drawn from `investigation.md`), then transition to the terminal
  `not-a-bug` status (`open -> not-a-bug`, or in `manual` mode via
  `open -> investigate-awaiting-approval -> not-a-bug` once the human
  confirms the early exit) and stop the pipeline. Do not proceed to plan.
  In `manual` mode the investigate gate offers the human two branches on
  an early-exit verdict: confirm the early exit (advance to `not-a-bug`
  and stop), or revise (re-run the investigator for a deeper look, e.g.
  with a hint, and re-parse the verdict). `not-a-bug` is terminal and has
  no outgoing edge; the issue folder is not auto-archived (move it out of
  the active set by hand if you want).

### Build phase specifics

- **Set up the dedicated branch and isolated worktree first**, before the
  entry transition and before invoking the builder. The build always runs
  on its own branch inside its own worktree, never in the main checkout or
  on the current branch. This step is idempotent and resume-safe: on a
  rework round or a resumed run the branch and worktree already exist, so
  reuse them rather than recreating.
  - **Branch name.** Reuse `state.json.branch` if it is already set (a
    resume or a rework round). Otherwise derive a flat, issue-linked name
    from the issue number and a short slug of the issue title:
    `<issue>-<slug>` for a GitHub issue (e.g. `142-crash-on-empty`),
    `<id>-<slug>` for a local issue (e.g. `L3-cache-key`). Keep it flat:
    no `fix/`, `feat/`, or `issue-NN/` prefix. Lowercase the slug, replace
    runs of non-alphanumerics with a single `-`, trim to a few words.
    Write the chosen name to `state.json.branch` so every later round and
    the `/merge-pr` teardown resolve the same branch.
  - **Worktree path.** Derive the repo's main-checkout parent as in the
    state-root step (`<parent>`, `<repo>`); the worktree lives at
    `<parent>/<repo>.worktrees/<branch>/`, matching the toolkit's worktree
    convention and where `/merge-pr` looks to tear it down.
  - **Create idempotently.** If `git worktree list --porcelain` already
    has a worktree for `<branch>`, reuse it. Otherwise create it off the
    base branch: `git worktree add -b <branch> <parent>/<repo>.worktrees/<branch> <base>`
    (use `git worktree add <path> <branch>` without `-b` if the branch
    already exists but has no worktree). `<base>` is the repo's default
    branch. Never create the worktree inside the repo root.
- The entry transition is its own step: from `ready-for-dev` or
  `blocked`, first transition to `in-progress` (the script has no
  `ready-for-dev -> ai-review` edge); if already at `in-progress`, skip
  that (there is no `in-progress -> in-progress` edge). The agent runs,
  opens/updates the PR with a clean `Closes #<issue>` body, writes
  `build.md`, then you transition `in-progress -> ai-review`.
- **Hand the builder the worktree path.** When you invoke the build agent,
  pass the absolute worktree path (`<parent>/<repo>.worktrees/<branch>/`)
  as the worktree it must `cd` into and work in, alongside the artifact
  paths. The builder does not create its own branch or worktree; it works
  where you put it and opens the PR from that branch. This same worktree is
  reused for every QA rework round.
- Record the PR number: after the build agent returns, re-derive the
  linked PR (see Finding the linked PR) and write it to
  `state.json.prNumber` as a cache. Never trust a stored `prNumber` over
  a fresh lookup.

### QA phase specifics

- The reviewer is invoked **bug-aware**: hand it `investigation.md` and
  `plan.md`, plus this extra instruction in the prompt: "This is a bug
  fix. Beyond mapping the diff to the plan, verify from the diff that a
  regression test exists and that it covers the root cause cited in
  investigation.md, so the bug cannot silently return. If no regression
  test covers the cited root cause, the verdict is rejected." The reviewer
  reasons from the diff; it does not re-run the reproduction (its tooling
  is read-only). The reviewer's `<!-- QA-VERDICT: approved|rejected -->`
  HTML-comment last-line convention is unchanged.
- Read the verdict from the last line matching `QA-VERDICT:` in `qa.md`
  (the `<!-- QA-VERDICT: ... -->` HTML comment), not from the agent's
  return.
- In `auto`/`semi-auto`: on `rejected`, route `qa.md` plus the rejection
  back to the **build** agent as fixup feedback, transition `ai-review
  -> in-progress`, re-run build, transition back to `ai-review`, re-run
  QA. Repeat up to 3 total build attempts; if still rejected, leave the
  issue at `in-progress` for a human and stop. On `approved`, transition
  `ai-review -> human-review`.
- In `manual`: after writing `qa.md`, hit the QA approval gate (below).
- **Flip the PR out of draft on the way into `human-review`.** The
  builder opens the PR as a draft and it stays draft through every rework
  round; the moment the issue reaches `human-review` (QA approved), the
  build/QA loop has stabilized, so mark the PR ready for review with
  `gh pr ready <pr>` (re-derive `<pr>` fresh, see Finding the linked PR).
  Do this in every mode when the transition into `human-review` happens
  (the direct `ai-review -> human-review` in auto/semi-auto, and the
  `qa-awaiting-approval -> human-review` approve branch in manual). It is
  idempotent, an already-ready PR is fine; a failure here is a soft
  warning, not a pipeline failure.

## The single validated status mutator

The **only** way you change `state.json.status` is by shelling out to
the transition script. It ships with the plugin (you never copy it into
the target repo); reference it by the plugin-root path variable. You never
write the `status` field with your own `jq`/`Write`:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-transition.sh" <root> <issue> <to-status>
```

- Check the exit code. A non-zero exit is a hard error (an illegal
  transition, or a missing state file): surface it, do not swallow it,
  do not retry with a different target to force it through.
- You **do** directly write the other `state.json` fields (`mode`,
  `branch`, `prNumber`, `qaVerdict`, `investigationVerdict`,
  `pendingQuestion`, `dependsOn`) with `jq`/an edit, since those are not
  the state machine and have no transition rules. Only `status` is gated.
- Statuses are bare (no `status:` prefix). The bug pipeline uses: `open`,
  `investigated`, `ready-for-dev`, `in-progress`, `blocked`, `ai-review`,
  `human-review`, `closed`, the terminal `not-a-bug`, and the four gates
  `investigate-awaiting-approval`, `plan-awaiting-approval`,
  `build-awaiting-approval`, `qa-awaiting-approval`. It never emits
  `spec-ready` or `spec-awaiting-approval` (those are the feature
  pipeline's).

## Raising a question (the interactive, resumable core)

Whenever a question must be surfaced (an agent returned
`clarification-needed`, a manual gate needs an approve/revise decision,
or a dependency is missing), do this in exactly this order:

1. **Write `state.json.pendingQuestion` first**, before any prompt:
   `{"phase": "investigate"|"plan"|"build"|"qa"|"dependency"|"gate",
   "question": "...", "options": [{"label": "...", "description": "..."},
   ...], "recommendedDefault": "label of the recommended (first) option"}`.
2. **Call `AskUserQuestion`** with those options, recommended first.
   **All context the human needs to answer must live inside the question
   text and the option `label`/`description` fields. Never print
   decision context as prose before the call.** This is a hard rule:
   text emitted just before an `AskUserQuestion` call can be dropped in
   a background session, so a self-contained question is the only kind
   that survives.
3. **If no answer comes back** (the prompt timed out, returned a "no
   response" / "proceed on best judgment" signal, or otherwise came back
   empty): **do not guess and do not proceed on a default.** Stop the
   run cleanly, leaving `pendingQuestion` set exactly as written in step
   1 and `status` unchanged. A later re-run re-asks the exact question
   (see the resume section) and picks up from there. `AskUserQuestion`
   has a fixed ~60s timeout after which the model is told to continue on
   its own judgment, and in a background session the prompt may not
   surface at all; treating either as "no answer, stop" is what keeps a
   real investigation/plan/gate decision from being silently steamrolled
   by a default no human ever saw. The only exception is `auto` mode,
   which by design raises no question in the first place (the agent
   adopts its own recommended default and records it in the artifact), so
   there is nothing here to time out.
4. **On the answer: clear `pendingQuestion` to `null`**, then fold the
   answer into the next action.

Because artifacts are written only after every question is answered,
the answer always flows into the agent (or the gate/dependency branch),
never into a half-written file. There is nothing to reconcile. And
because the question is persisted before it is asked, a timeout or a
non-surfacing background prompt loses nothing: the next run re-asks it.

## Modes: two orthogonal axes

Evaluate these two decisions separately for every phase.

- **Questions axis** (is an agent's raised ambiguity surfaced?):
  - `auto`: never. Invoke the agent told to adopt its own recommended
    default and record the decision in the artifact, so it returns
    `done`. Nothing is written to `pendingQuestion`; nothing prompts.
  - `semi-auto` / `manual`: a `clarification-needed` return is surfaced
    inline via the procedure above.
- **Artifact-approval axis** (do you stop after a written artifact?):
  - `auto` / `semi-auto`: auto-approve every artifact; advance
    immediately.
  - `manual`: after each phase's artifact is written and read back, use
    `AskUserQuestion` to approve or revise. `approve` advances via the
    transition script (into that phase's `*-awaiting-approval` gate then
    out to the real next status, matching the gate edges in the table).
    `revise` re-runs that phase's agent with the feedback, re-writes the
    artifact in place, and asks again. The QA-gate `revise` routes the
    feedback plus the current `qa.md` to the **build** agent (not QA),
    re-runs QA, re-writes `qa.md`, and stays at the gate.

The axes are genuinely orthogonal: an investigation with no question in
`semi-auto` still auto-approves; the same investigation in `manual` still
stops for approval even though no question was raised.

The investigate approval gate has one extra branch over the others: on an
early-exit verdict (`not-a-bug`/`cannot-reproduce`), `approve` confirms
the early exit and advances to the terminal `not-a-bug`, while `revise`
re-runs the investigator for a deeper look. On a `bug-confirmed` verdict
it behaves like the spec gate: `approve` advances to `investigated`,
`revise` re-runs the investigator.

## dependsOn: read-only, one-directional access

- Before invoking the investigate/plan/build agent for issue N, read
  `state.json.dependsOn` (default `[]`). For each depended-on issue D,
  resolve `<root>/D/spec.md`, `<root>/D/investigation.md`, and
  `<root>/D/plan.md`; if D is not in the active set, fall back to
  `<root>/archive/D/...` (a merged dependency is moved there by
  `/merge-pr`, and its artifacts stay valid read-only context). A
  depended-on issue may be a feature (with `spec.md`) or a bug (with
  `investigation.md`); pass whichever upstream artifacts exist.
- If those exist, pass them as **read-only** paths in the agent prompt.
  If `dependsOn` is empty, pass no other-issue path at all. Never hand
  issue N's agent the path where a non-dependency issue could be
  written; one-directionality is structural, not a rule the agent must
  remember.
- If a depended-on `D`'s folder or artifacts **do not exist** when
  they'd be read: do not silently proceed and do not hard-block. Raise a
  question (via the procedure above, `phase: "dependency"`) with options
  "Proceed without the missing dependency" (recommended default, so a
  bare run still moves) and "Wait". If the human picks "Wait", stop
  cleanly with `pendingQuestion` cleared and `status` unchanged, so a
  later re-run retries the dependency.

## Finding the linked PR

Re-derive the PR fresh whenever you need it; never trust a stored
`prNumber` over a fresh lookup.

For a **GitHub issue**, the PR is the one GitHub considers linked (its
body references it via `Closes #N`):

```
gh repo view --json owner,name --jq '.owner.login + " " + .name'
gh api graphql -f query='query { repository(owner: "OWNER", name: "NAME") { issue(number: <issue>) { closedByPullRequestsReferences(first: 5) { nodes { number } } } } }'
```

For a **local issue** (id starts with `L`), the PR carries no `Closes`
link, so find it by the branch the build agent worked on instead:

```
gh pr list --head "$(git rev-parse --abbrev-ref HEAD)" --state all --json number --jq '.[0].number'
```

Take the number, or none. Cache it into `state.json.prNumber` after a
build, but always re-derive for QA.

Merging the finished PR is a separate skill, `/merge-pr <pr>`, which runs
its own safety gates (CI green, mergeable, no rule bypass without asking)
and marks this issue's `state.json` closed afterward. This pipeline stops
at `human-review`; it never merges.

## Anti-patterns

- Printing decision context as prose before an `AskUserQuestion` call.
  Put all of it inside the question and option text; a background
  session can drop pre-call text, so a self-contained question is the
  only safe kind.
- Writing `state.json.status` with your own `jq`/`Write`. Only the
  transition script moves the machine; check its exit code and treat a
  non-zero as a hard error.
- Prompting before persisting `pendingQuestion`. Persist first, always,
  so a killed session re-asks the exact question.
- Proceeding on a default when a question went unanswered (a timeout, a
  "proceed on best judgment" signal, or a background prompt that never
  surfaced). Stop with `pendingQuestion` still set and `status`
  unchanged; let a re-run re-ask it. Only `auto` mode may adopt a
  default, and only because it raised no question to begin with.
- Proceeding to plan on an early-exit verdict. `not-a-bug`,
  `cannot-reproduce`, and `works-as-intended` all stop the pipeline at
  the terminal `not-a-bug` status; never plan or build a fix for a bug
  the investigation could not confirm.
- Trusting the investigator's return over the `INVESTIGATION-VERDICT:`
  line in `investigation.md`; a malformed final line reads as
  `cannot-reproduce`, never `bug-confirmed`.
- Trusting session memory for "where am I". Read `state.json.status`
  and `pendingQuestion` every run.
- Posting anything to the issue thread, or adding a bookkeeping comment
  to the pull request. The only GitHub writes are the PR and its
  `Closes #N`.
- `git add`ing any file under `<repo>.issues/`, or writing an artifact
  inside the repo tree.
- Trusting an agent's "I wrote the file" over reading the file back;
  trusting the agent's summary of a QA verdict over the `QA-VERDICT:`
  line in `qa.md`.
- Launching multiple issues from here. This skill drives exactly one
  bug; a fleet is several independent background sessions, each its own
  `/debug-pipeline` run.

## Done criteria

The bug has advanced to its next resting point: an investigation written
and either confirmed (moving through plan, build, QA) or concluded not a
bug (stopped at the terminal `not-a-bug`), an artifact written for each
phase run, the status moved only through the transition script, any open
question persisted in `state.json.pendingQuestion` (and nothing else
recording it), no comment posted to the issue thread, and the only GitHub
writes being the pull request and its `Closes #N`. A re-run reads
`state.json` and resumes exactly where this one stopped.
