---
name: run-pipeline-gh
description: Drives one GitHub issue through spec -> plan -> build -> QA, keeping the state machine in a LOCAL state.json under ~/.claude/dev-crew/<repo>/<issue>/ (a hidden, persistent, Claude-standard location; no GitHub labels, so it works where status:* labels are unavailable or you lack rights to create them; and no <repo>.issues folder next to the user's checkout) while delivering every artifact to GitHub. The spec and plan are posted as tagged issue comments; the build summary, the QA report, and every build/QA rework round all live in the pull request body, which the skill rebuilds from parts each round. All human interaction is inline in this session. Use when the user says "run the gh pipeline on N", "drive issue N through the pipeline on GitHub", passes a mode (auto/semi-auto/manual), or invokes /run-pipeline-gh with an issue number.
---

# Issue pipeline (GitHub delivery, local state)

You drive one GitHub issue through spec -> plan -> build -> QA. You run
in this session's own context, so you own every `AskUserQuestion` and
every file read/write and GitHub read/write directly; you spawn the four
file-writing subagents for the heavy per-phase reasoning and hand each
one a concrete scratch path to write its artifact to. The four agents
write only to the filesystem (`spec.md`, `plan.md`, `build.md`,
`qa.md`) under `~/.claude/dev-crew/<repo>/<issue>/`; **you** read each
artifact back and deliver it to GitHub. Spec and plan go to tagged issue
comments; the build summary, the QA report, and every build/QA rework
round all live in the **pull request body**, which you own and rebuild
from its parts each round (see "Assembling the pull request body"). The
state machine lives in a **local `state.json`** in that same folder,
moved only through the single validated transition script. **No GitHub
label is ever read or written** (this is the whole point: it works in
repos where `status:*` labels are unavailable or you cannot create them).
Every human question lives inline in this session, never in a GitHub
comment you poll.

## Mission

Take the issue from wherever `state.json` says it is to the next resting
point: run each phase's agent, read its scratch artifact, deliver that
artifact to GitHub (spec/plan as tagged issue comments; the build
summary, the QA report, and every rework round assembled into the pull
request body), advance the status only through the transition script, and
surface every question inline in a way that survives the session being
killed. Where you are is always read from `state.json.status`, never from
a GitHub label and never from what you remember of this conversation.

## Setup (run once at the top of every invocation)

1. **Parse the argument** as `<issue> [mode]`. `mode` is one of `auto`,
   `semi-auto`, or `manual`. If no mode
   word is given, default to `semi-auto` (but see step 4: a persisted
   mode wins for a resume). Reject any other mode word loudly. (Merging a
   finished PR is a separate skill, `/merge-pr`, not a mode here.) The issue
   is always a GitHub issue number (this skill has no local-issue mode;
   use `run-pipeline` for those).
2. **Derive the state root under Claude's home**, not next to the repo.
   Unlike the file-based pipeline, this pipeline's real artifacts live on
   GitHub, so there is no reason to create a `<repo>.issues/` folder
   beside the user's checkout. The only thing that must persist locally is
   `state.json`, and it lives in a hidden, persistent, Claude-standard
   location:
   - Get the repo's basename: run `git rev-parse --git-common-dir`,
     resolve it to an absolute path, take its parent as the repo
     working-tree root (so all worktrees of one repo share one root), and
     call that directory's basename `<repo>`.
   - The state root is `~/.claude/dev-crew/<repo>`. Example: a repo at
     `~/Code/esqlabsR` gives a state root of `~/.claude/dev-crew/esqlabsR`.
     This is persistent (survives the machine being off, so a paused run
     resumes cleanly), hidden from the user's project directory, and never
     appears as a `<repo>.issues/` sibling of their repo.
   - The issue folder is `<root>/<issue>/`. `state.json` and the agents'
     scratch artifacts live inside it. `mkdir -p` it if it does not exist.
   - The scratch files are only the agents' output channel: **you** read
     each one back and deliver it to GitHub, then they are disposable. The
     public record lives on GitHub (the tagged spec/plan issue comments
     and the pull request body); the durable private record of *where the
     machine is* is `state.json`.
3. **Bootstrap the issue folder.** If `<root>/<issue>/state.json` does
   not exist, seed it with `{"status": "open", "mode": "<mode>",
   "branch": null, "prNumber": null, "qaVerdict": null,
   "pendingQuestion": null, "dependsOn": []}` (the mode from step 1).
4. **Reconcile mode.** If `state.json` already existed and the caller
   passed no mode word, use the persisted `state.json.mode`. If the
   caller passed a mode word, write it into `state.json.mode` (a rerun
   may legitimately change the mode).
5. **Rename this background job** to a clean, issue-derived title so a
   wall of parallel pipeline runs is legible at a glance. Fetch the issue
   title with `gh issue view <issue> --json title --jq .title`, then shell
   out to the rename script:
   ```
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-rename-job.sh" <issue> "<title>"
   ```
   The script writes `#<issue> <slug>` into the running job's title and
   pins it. It is a silent no-op in a foreground run (no background job to
   rename) and a soft step overall: a non-zero exit or an unfetchable
   title is a warning, not a pipeline failure, so never let it block the
   phase loop.

## Resume a pending question first (before any phase)

Because the state is local and persists across sessions, a killed,
slept, or closed session loses nothing. Immediately after loading
`state.json`, before touching any phase:

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

The question survives in `state.json`, no artifact was written and
nothing was posted to GitHub for it, and this re-ask is the recovery
path.

## The phase loop

Read `state.json.status` and drive the phase whose entry status matches.
The phases, their agents, their GitHub delivery target, and their
transition edges (all applied only through the transition script):

| Phase | Entry status | Agent | Artifact -> GitHub | On success -> |
| --- | --- | --- | --- | --- |
| spec  | `open` | `dev-crew:spec-writer` | tagged issue comment `<!-- gh-pipeline:spec -->` | `spec-ready` |
| plan  | `spec-ready` | `dev-crew:planner` | tagged issue comment `<!-- gh-pipeline:plan -->` | `ready-for-dev` |
| build | `ready-for-dev`, `in-progress`, `blocked` | `dev-crew:builder` | rebuild the PR body (first round: base content; later rounds: a `## Changes` entry under `# Updates`) | first `in-progress`, then `ai-review` |
| qa    | `ai-review` | `dev-crew:reviewer` | rebuild the PR body (the QA block; later rounds: a `## QA` entry under `# Updates`) | `human-review` (approved) or `in-progress` (rejected) |

Every issue runs the full spec -> plan -> build -> QA path.

For each phase, in order:

1. **Compute the artifact path** as an absolute scratch path:
   `<root>/<issue>/spec.md`, `.../plan.md`, `.../build.md`, `.../qa.md`.
2. **Resolve dependency read-paths** (see the dependsOn section). Pass
   depended-on issues' `spec.md`/`plan.md` paths as read-only context;
   pass no other-issue path when `dependsOn` is empty.
3. **Invoke the phase agent** with a `schema` forcing the structured
   return object (so the agent returns the object, not prose). Hand it:
   the issue number, the exact absolute path to write its artifact to,
   the read-only upstream/dependency paths, and, in `auto` mode, the
   instruction to adopt its own recommended default on any ambiguity and
   record the decision in the artifact (so it returns `done`, never
   `clarification-needed`). The agent never posts to GitHub; only the
   builder touches the PR, and only to open it as a draft placeholder.
   Tell the builder explicitly that **you own the pull request body**, so
   it opens the PR with only a minimal `Closes #<issue>` placeholder body
   and never `gh pr edit`s the body itself (you build the body from
   `build.md`; see "Assembling the pull request body").
4. **On a `clarification-needed` return** (only possible in
   `semi-auto`/`manual`): follow "Raising a question" below, then
   re-invoke this same phase agent with the answer folded into its
   instructions. The agent writes its artifact only after the answer is
   in hand. For spec/plan, if the question is still unresolved when you
   post, render a `[NEEDS CLARIFICATION]` visibility block into the
   posted comment (see "Rendering a clarification block").
5. **On a `done` return**: read the artifact back from the scratch path
   to confirm it exists and is non-empty (never trust the agent's
   summary that it wrote the file), then **deliver it to GitHub** for
   this phase (see "Delivering an artifact to GitHub"). For QA, parse the
   trailing line matching `QA-VERDICT:` from `qa.md` itself (it is an HTML
   comment, `<!-- QA-VERDICT: approved -->` / `<!-- QA-VERDICT: rejected
   -->`; grep the last such line and read the verdict word) and record it
   in `state.json.qaVerdict`.
6. **Artifact-approval gate** (see the modes section): in `manual` mode,
   stop for an approve/revise decision before advancing; in
   `auto`/`semi-auto`, advance immediately.
7. **Advance the status** by shelling out to the transition script (see
   below). Then re-read `state.json.status` and continue to the next
   phase.

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
    `<issue>-<slug>` for a GitHub issue (e.g. `142-pkpd-warning`),
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
  - **Hand the builder the worktree path.** When you invoke the build
    agent, pass the absolute worktree path
    (`<parent>/<repo>.worktrees/<branch>/`) as the worktree it must `cd`
    into and work in, alongside the artifact paths. Tell it **you own the
    pull request body**, so it opens the PR with only a minimal `Closes
    #<issue>` placeholder body and never edits the body. The builder does
    not create its own branch or worktree; it works where you put it and
    opens the PR from that branch. This same worktree is reused for every
    QA rework round.
- The entry transition is its own step: from `ready-for-dev` or
  `blocked`, first transition to `in-progress` (the script has no
  `ready-for-dev -> ai-review` edge); if already at `in-progress`, skip
  that (there is no `in-progress -> in-progress` edge). The agent runs,
  opens the PR (first round) with a minimal `Closes #<issue>` placeholder
  body, and writes `build.md`. Then **you** deliver by **rebuilding the
  whole PR body** from its parts (see "Assembling the pull request body"):
  - **First build round.** Snapshot `build.md` as this issue's base PR
    content (copy it to `<root>/<issue>/pr-content.md`), then assemble and
    write the body. At this point the body is just `Closes #<issue>` plus
    the base content; there is no QA block or `# Updates` section yet.
  - **Later rounds** (a QA-rejection fixup or a manual build-gate revise).
    Append this round to the issue's ordered round log: archive the fresh
    `build.md` as the next `## Changes` entry (see "Assembling the pull
    request body" for the round-log mechanism), then reassemble and
    rewrite the whole body. Never post a PR comment and never leave a
    stale body: the body is always the single rebuilt document.

  Finally transition `in-progress -> ai-review`.
- Record the PR number: after the build agent returns, re-derive the
  linked PR (see Finding the linked PR) and write it to
  `state.json.prNumber` as a cache. Never trust a stored `prNumber` over
  a fresh lookup.

### QA phase specifics

- Read the verdict from the last `QA-VERDICT:` line of `qa.md`, not from
  the agent's return, and record it in `state.json.qaVerdict`. Then
  **deliver by rebuilding the PR body** (see "Assembling the pull request
  body"): the reviewer already shaped `qa.md` as the `# QA: Approved` /
  `# QA: Rejected` block (verdict header, short summary, `<details>` full
  report, trailing `<!-- QA-VERDICT: ... -->`), so you place it verbatim.
  - **First QA** (the QA of the first build round, before any rejection):
    this block is the top-level QA block that sits directly under the base
    PR content. Record it as the current QA block and reassemble the body.
  - **Re-review** (the QA after a rejection fixup): archive this block as
    the next `## QA` entry in the round log (pairing the `## Changes` entry
    from the build round it reviewed), then reassemble the body.
- In `auto`/`semi-auto`: on `rejected`, route `qa.md` plus the rejection
  back to the **build** agent as fixup feedback, transition `ai-review
  -> in-progress`, re-run build (which archives a `## Changes` round entry
  and rebuilds the body), transition back to `ai-review`, and re-run QA
  (which archives the matching `## QA` round entry and rebuilds the body).
  Repeat up to 3 total build attempts; if still rejected, leave the issue
  at `in-progress` for a human and stop. On `approved`, transition
  `ai-review -> human-review`.
- In `manual`: after rebuilding the body with the QA block, hit the QA
  approval gate (below).
- **Flip the PR out of draft on the way into `human-review`.** The
  builder opens the PR as a draft and it stays draft through every rework
  round; the moment the issue reaches `human-review` (QA approved), the
  build/QA loop has stabilized, so mark the PR ready for review with
  `gh pr ready <pr>` (re-derive `<pr>` fresh, see Finding the linked PR).
  Do this in every mode when the transition into `human-review` happens
  (the direct `ai-review -> human-review` in auto/semi-auto, and the
  `qa-awaiting-approval -> human-review` approve branch in manual). It is
  idempotent, an already-ready PR is fine; a failure here is a soft
  warning, not a pipeline failure. This is a PR-state change (`gh pr
  ready`), not a body rewrite or a comment, so it stands apart from the
  body-assembly flow.

## The single validated status mutator

The **only** way you change `state.json.status` is by shelling out to
the transition script. It ships with the plugin (you never copy it into
the target repo); reference it by the plugin-root path variable. You never
write the `status` field with your own `jq`/`Write`, and you never touch a
GitHub label:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-transition.sh" <root> <issue> <to-status>
```

- Three arguments, in order: the state root `<root>` (from setup step
  2), the issue number, and the **bare** target status.
- `<to-status>` is a **bare** status with **no `status:` prefix**, e.g.
  `spec-ready`, not `status:spec-ready`.
- Check the exit code. A non-zero exit is a hard error (an illegal
  transition, or a missing state file): surface it, do not swallow it,
  do not retry with a different target to force it through.
- The script reads the current status from `state.json` itself and
  validates the edge; you only name the target.
- You **do** directly write the other `state.json` fields (`mode`,
  `branch`, `prNumber`, `qaVerdict`, `pendingQuestion`, `dependsOn`) with
  `jq`/an edit, since those are not the state machine and have no
  transition rules. Only `status` is gated.
- Statuses are bare (no `status:` prefix): `open`, `spec-ready`,
  `ready-for-dev`, `in-progress`, `blocked`, `ai-review`,
  `human-review`, `closed`, and the four manual-mode gates
  `spec-awaiting-approval`, `plan-awaiting-approval`,
  `build-awaiting-approval`, `qa-awaiting-approval`.

## Delivering an artifact to GitHub

Once a phase agent returns `done` and you have confirmed the scratch
artifact is present and non-empty, deliver it. Always deliver via
`--body-file` (write the full body to a temp file and pass that file),
never an inlined `--body`: it keeps the (possibly large) artifact off the
shell command line and avoids any quoting corruption of multi-line
markdown. The two spec/plan phases post issue comments; the build and QA
phases both write the **pull request body**, which you rebuild from parts.

- **spec / plan** -> a **tagged issue comment**. Build the temp body by
  writing a small header prefix (the phase tag, and the notify @-mention)
  and then appending the scratch artifact verbatim. Prefix with the phase
  tag (`<!-- gh-pipeline:spec -->` or `<!-- gh-pipeline:plan -->`) and the
  mention, then the artifact. Post with `gh issue comment <issue>
  --body-file <file>`. On a revise round (see modes), edit the existing
  tagged comment in place instead: find the last comment carrying that
  phase's tag and `PATCH` its body, adding a short "What changed" note at
  the top.
- **build / QA** -> the **pull request body**. You never post a PR
  comment; every build summary and QA report lives in the body. Rebuild
  the whole body from its parts and write it with `gh pr edit <pr>
  --body-file <file>` (see "Assembling the pull request body").

The notify @-mention is a single configurable GitHub username pinged when
an artifact is posted or revised (GitHub auto-notifies the author, but an
explicit mention is the reliable trigger). Fold it into the spec/plan
comment header prefix; leave it out if none is configured. (The PR body
has no @-mention line: the builder's `gh pr create` already notifies the
author, and later body rewrites should not re-ping on every round.)

Delivering to GitHub is a plain comment/PR-body write. It is **not** a
label write: nothing here reads or edits any `status:*` (or other) label.

## Assembling the pull request body

The pull request body is a single document you own and rewrite in full on
every build and QA delivery. Never post a PR comment and never edit it by
hand-splicing text into the live body: always reassemble it from the
issue's saved parts and overwrite it with `gh pr edit <pr> --body-file
<file>`. Rewriting the whole body each time makes the result deterministic
and resume-safe: the same parts always produce the same body, so a
re-run, a retried round, or a resumed session cannot duplicate or
half-write a section.

### The saved parts (all under `<root>/<issue>/`)

- `pr-content.md` -> the base PR content: a snapshot of the first build
  round's `build.md`, taken once when the PR is first opened. This is the
  "what this PR does" top section and does not change on later rounds.
- `qa.md` -> the current QA block (the reviewer's latest report, already
  shaped as the `# QA:` header + summary + `<details>` + trailing
  `<!-- QA-VERDICT: ... -->`). Overwritten by each QA run; the body always
  shows the latest verdict up top.
- The **round log**, an ordered set of per-round entries for the
  `# Updates` section. Store each round as a pair of numbered files:
  `round-<n>-changes.md` (a build round's `build.md`, archived when that
  rework round runs) and `round-<n>-qa.md` (the matching re-review's
  `qa.md`, archived when that re-review runs). `<n>` starts at 1 for the
  first rework round (the first QA rejection's fixup). Round 0 is the
  initial build + first QA and lives in the top sections, not the log.
  Archive by copying the fresh scratch file to its numbered name at the
  moment that round's phase delivers, then reassemble; the numbered files
  are the durable per-round record (the scratch `build.md`/`qa.md` get
  overwritten each round, so the archive is what survives).

### The layout

Assemble the body in this fixed order, then write it via `gh pr edit`:

```
Closes #<issue>

<contents of pr-content.md>

<contents of qa.md — the current QA block: "# QA: Approved/Rejected",
 the short summary, the <details> full report, and the trailing
 <!-- QA-VERDICT: ... --> comment>

# Updates

## Changes
<contents of round-1-changes.md>

## QA
<contents of round-1-qa.md>

## Changes
<contents of round-2-changes.md>

## QA
<contents of round-2-qa.md>

...one ## Changes / ## QA pair per round, in order...
```

Rules for the layout:

- **`Closes #<issue>` always leads the body** (for a local `L`-id, the
  local-id reference line instead, which has no `Closes`), so the overlay
  never strips the issue link the `closedByPullRequestsReferences` lookup
  relies on (see "Finding the linked PR"). Skip the `Closes` line for a
  local issue, which has no link to preserve.
- **The QA block only appears once QA has run.** On the very first build
  delivery (before any QA), there is no `qa.md` yet, so the body is just
  `Closes` + `pr-content.md`.
- **The `# Updates` section only appears once at least one rework round
  exists** (i.e. there is a `round-1-*` entry). Before the first QA
  rejection there are no rework rounds, so omit `# Updates` entirely.
- **A round's `## QA` may lag its `## Changes` by one delivery.** A build
  rework round archives `round-<n>-changes.md` and rebuilds the body
  before its re-review has run; at that instant `round-<n>-qa.md` does not
  exist yet, so render the `## Changes` entry with no `## QA` under it.
  The next QA delivery archives `round-<n>-qa.md` and rebuilds again,
  filling it in.

## Rendering a clarification block

When a spec/plan agent's `clarification-needed` return is still
unresolved at the moment you post (only possible if you could not get an
inline answer, e.g. a background session where the prompt never
surfaced), render a visibility block at the top of the posted comment so
a human sees it on the issue:

```
[NEEDS CLARIFICATION] <the exact question>

Options:
1. <label> (recommended default): <description>
2. <label>: <description>
...
```

List the recommended default first, matching the agents' contract. In a
foreground session you will normally have resolved it inline before
posting, so no block is needed; the block is the fallback for a question
that could not be answered. Note this is only rendered when you also
persisted the question in `state.json.pendingQuestion` and stopped
(see "Raising a question"); the block is a courtesy for a human reading
the issue, not a substitute for the local pending-question record.

## Raising a question (the interactive, resumable core)

Whenever a question must be surfaced (an agent returned
`clarification-needed`, a manual gate needs an approve/revise decision,
or a dependency is missing), do this in exactly this order:

1. **Write `state.json.pendingQuestion` first**, before any prompt:
   `{"phase": "spec"|"plan"|"build"|"qa"|"dependency"|"gate", "question":
   "...", "options": [{"label": "...", "description": "..."}, ...],
   "recommendedDefault": "label of the recommended (first) option"}`.
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
   real spec/plan/gate decision from being silently steamrolled by a
   default no human ever saw. The only exception is `auto` mode, which by
   design raises no question in the first place (the agent adopts its own
   recommended default and records it in the artifact), so there is
   nothing here to time out.
4. **On the answer: clear `pendingQuestion` to `null`**, then fold the
   answer into the next action.

Because agents write their artifact only after every question is
answered (and you post to GitHub only after an artifact is written), the
answer always flows into the agent (or the gate/dependency branch),
never into a half-written file, and nothing is posted to GitHub for an
unanswered question. And because the question is persisted before it is
asked, a timeout or a non-surfacing background prompt loses nothing: the
next run re-asks it.

## Modes: two orthogonal axes

Evaluate these two decisions separately for every phase.

- **Questions axis** (is an agent's raised ambiguity surfaced?):
  - `auto`: never. Invoke the agent told to adopt its own recommended
    default and record the decision in the artifact, so it returns
    `done`. Nothing is written to `pendingQuestion`; nothing prompts.
  - `semi-auto` / `manual`: a `clarification-needed` return is surfaced
    inline via the procedure above.
- **Artifact-approval axis** (do you stop after a delivered artifact?):
  - `auto` / `semi-auto`: auto-approve every artifact; advance
    immediately after posting it.
  - `manual`: after each phase's artifact is delivered, use
    `AskUserQuestion` to approve or revise. `approve` advances via the
    transition script (into that phase's `*-awaiting-approval` gate then
    out to the real next status, matching the gate edges in the script's
    table). `revise` re-runs that phase's agent with the feedback,
    re-writes the artifact, and re-delivers it to GitHub (spec/plan: edit
    the existing tagged comment in place with a "What changed" note;
    build: treat the revise as a rework round, archiving a `## Changes`
    round entry and rebuilding the PR body), then asks again. The QA-gate
    `revise` routes the feedback plus the current `qa.md` to the **build**
    agent (not QA), which archives a `## Changes` round entry and rebuilds
    the body, then re-runs QA (archiving the matching `## QA` round entry
    and rebuilding the body again), and stays at the QA gate.

The axes are genuinely orthogonal: a spec with no question in
`semi-auto` still auto-approves; the same spec in `manual` still stops
for approval even though no question was raised.

## dependsOn: read-only, one-directional access

- Before invoking the spec/plan/build agent for issue N, read
  `state.json.dependsOn` (default `[]`). For each depended-on issue D,
  resolve `<root>/D/spec.md` and `<root>/D/plan.md`.
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

Re-derive the PR fresh whenever you need it (build, QA, merge); never
trust a stored `prNumber` over a fresh lookup. The PR is the one GitHub
considers linked (its body references the issue via `Closes #N`):

```
gh repo view --json owner,name --jq '.owner.login + " " + .name'
gh api graphql -f query='query { repository(owner: "OWNER", name: "NAME") { issue(number: <issue>) { closedByPullRequestsReferences(first: 5) { nodes { number } } } } }'
```

Take the first node's number, or none. Cache it into
`state.json.prNumber` after a build, but always re-derive for QA and
merge. If a phase that needs the PR (build delivery, QA, merge) finds
none, fail loudly rather than proceeding.

Merging the finished PR is a separate skill, `/merge-pr <pr>`, which runs
its own safety gates (CI green, mergeable, no branch-protection bypass
without asking) and marks this issue's `state.json` closed afterward. This
pipeline stops at `human-review`; it never merges.

## Anti-patterns

- Reading or writing **any GitHub label**. This skill never runs `gh
  issue view --json labels`, never `gh issue edit --add-label`/
  `--remove-label`, never uses a `status:`-prefixed status, and never
  infers state from a label. State lives only in `state.json`. This is
  the whole reason the skill exists: to work where `status:*` labels are
  unavailable or uncreatable.
- Writing `state.json.status` with your own `jq`/`Write`. Only the
  transition script moves the machine; call it in its three-argument
  form with the state root and a bare (unprefixed) status, check its
  exit code, and treat a non-zero as a hard error.
- Prompting before persisting `pendingQuestion`. Persist first, always,
  so a killed session re-asks the exact question.
- Proceeding on a default when a question went unanswered (a timeout, a
  "proceed on best judgment" signal, or a background prompt that never
  surfaced). Stop with `pendingQuestion` still set and `status`
  unchanged; let a re-run re-ask it. Only `auto` mode may adopt a
  default, and only because it raised no question to begin with.
- Printing decision context as prose before an `AskUserQuestion` call.
  Put all of it inside the question and option text; a background session
  can drop pre-call text, so a self-contained question is the only safe
  kind.
- Trusting session memory for "where am I". Read `state.json.status` and
  `pendingQuestion` every run, and re-derive the linked PR every time you
  need it.
- Letting a phase agent post to GitHub. The agents are file-only (the
  builder alone touches the PR, and only to open it as a draft with a
  minimal `Closes #<issue>` placeholder body); reading the scratch
  artifact back and delivering it is your job.
- Posting via an inlined `--body` (shell-quoting corrupts multi-line
  markdown) instead of `--body-file`. Always build the body on disk and
  post the file.
- Posting a PR comment for the build summary, the QA report, or a rework
  round. There are no PR comments in this pipeline: the build summary, the
  QA report, and every rework round all live in the PR body, which you
  rebuild from parts and overwrite with `gh pr edit --body-file`.
- Hand-splicing new text into the live PR body, or letting stale rounds
  survive because you only appended. Always reassemble the whole body from
  the saved parts (`pr-content.md`, `qa.md`, the `round-<n>-*` log) and
  overwrite it, so the result is deterministic and cannot duplicate a
  section on a retry or resume.
- Trusting an agent's "I wrote the file" over reading the file back;
  trusting the agent's summary of a QA verdict over the `QA-VERDICT:`
  line in `qa.md`.
- Writing `state.json` or a scratch artifact inside the repo tree, or
  `git add`ing it. State and scratch live under `~/.claude/dev-crew/`,
  outside the checkout, by construction.
- Launching multiple issues from here. This skill drives exactly one
  issue; a fleet is several independent background sessions, each its own
  `/run-pipeline-gh` run.

## Done criteria

The issue has advanced to its next resting point: each phase run's
artifact delivered to its GitHub target (spec/plan as tagged issue
comments; the build summary, the QA report, and every rework round
assembled into the PR body, which was rebuilt from its saved parts and
overwritten via `gh pr edit --body-file`, never a PR comment), the state
moved only through the transition script (a local `state.json.status`,
never a label), any open question persisted in
`state.json.pendingQuestion` (and, if it could not be answered, also
rendered as a `[NEEDS CLARIFICATION]` block in the posted spec/plan
comment) with nothing else recording it, and the agents having written
only their scratch artifacts. No GitHub label was read or written at any
point. A re-run reads `state.json` and resumes exactly where this one
stopped.
