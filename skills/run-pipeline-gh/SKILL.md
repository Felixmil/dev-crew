---
name: run-pipeline-gh
description: Drives one GitHub issue through spec -> plan -> build -> QA with state in a hidden local state.json (no GitHub labels) while delivering every artifact to GitHub, spec and plan as tagged issue comments, the build summary and QA report assembled into the PR body. Use when the user says "run the gh pipeline on N", "drive issue N through the pipeline on GitHub", passes a mode, or invokes /run-pipeline-gh with an issue number.
---

# Issue pipeline (GitHub delivery, local state)

You drive one GitHub issue through spec -> plan -> build -> QA. You run in this session's own context, so you own every `AskUserQuestion` and every file read/write and GitHub read/write directly; you spawn the four file-writing subagents and hand each one a concrete scratch path to write its artifact to. The four agents write only to the filesystem (`spec.md`, `plan.md`, `build.md`, `qa.md`) under `~/.claude/dev-crew/<repo>/<issue>/`; **you** read each artifact back and deliver it to GitHub. Spec and plan go to tagged issue comments; the build summary, the QA report, and every build/QA rework round all live in the **pull request body**, which you own and rebuild from its parts each round. The state machine lives in a **local `state.json`** in that same folder, moved only through the transition script. **No GitHub label is ever read or written** (this is the whole point: it works in repos where `status:*` labels are unavailable or you cannot create them). Every human question lives inline in this session, never in a GitHub comment you poll.

This skill shares its machinery with the other pipelines through reference files under `${CLAUDE_PLUGIN_ROOT}/references/pipeline/`. Read each one at the point the sections below send you to it, and follow it exactly; the GitHub-delivery and PR-body-assembly sections below are what is specific to this pipeline.

## Mission

Take the issue from wherever `state.json` says it is to the next resting point: run each phase's agent, read its scratch artifact, deliver that artifact to GitHub (spec/plan as tagged issue comments; the build summary, QA report, and every rework round assembled into the PR body), advance the status only through the transition script, and surface every question inline in a way that survives the session being killed. Where you are is always read from `state.json.status`, never from a GitHub label and never from what you remember of this conversation.

## Setup

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/state-and-setup.md`. This pipeline fills its deltas as follows:

- **State root**: `~/.claude/dev-crew/<repo>`, under Claude's home, *not* next to the repo. This pipeline's real artifacts live on GitHub, so there is no reason to create a `<repo>.issues/` folder beside the user's checkout; the only thing that must persist locally is `state.json`. Get `<repo>` from git (`git rev-parse --git-common-dir`, resolve to an absolute path, take its parent as the working-tree root so all worktrees of one repo share one root, and use that directory's basename). Example: a repo at `~/Code/esqlabsR` gives a state root of `~/.claude/dev-crew/esqlabsR`. This location is persistent (survives the machine being off, so a paused run resumes cleanly) and hidden from the user's project directory. The scratch artifacts live in `<root>/<issue>/` too; they are the agents' output channel only, disposable once delivered to GitHub.
- **Seed object**: the standard fields, no extras.
- **No archive check.** The gh-pipeline root is hidden state, not a browsable working set, and is never archived; there is no `<root>/archive/` to check.
- **The issue is always a GitHub issue number.** This skill has no local-issue mode; use `/run-pipeline` for those.

## Resume and raising questions

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/raising-questions.md` exactly. Because the state is local and persists across sessions, a killed, slept, or closed session loses nothing: the question survives in `state.json`, nothing was posted to GitHub for it, and the re-ask on the next run is the recovery path.

For a spec/plan question that is still unresolved at the moment you post (only possible if you could not get an inline answer, e.g. a background session where the prompt never surfaced), also render a `[NEEDS CLARIFICATION]` visibility block into the posted comment (see "Rendering a clarification block").

## The phase loop

Read `state.json.status` and drive the phase whose entry status matches:

| Phase | Entry status | Agent | Artifact -> GitHub | On success -> |
| --- | --- | --- | --- | --- |
| spec  | `open` | `dev-crew:spec-writer` | tagged issue comment `<!-- gh-pipeline:spec -->` | `spec-ready` |
| plan  | `spec-ready` | `dev-crew:planner` | tagged issue comment `<!-- gh-pipeline:plan -->` | `ready-for-dev` |
| build | `ready-for-dev`, `in-progress`, `blocked` | `dev-crew:builder` | rebuild the PR body (first round: base content; later rounds: a `## Changes` entry under `# Updates`) | first `in-progress`, then `ai-review` |
| qa    | `ai-review` | `dev-crew:reviewer` | rebuild the PR body (the QA block; later rounds: a `## QA` entry under `# Updates`) | `human-review` (approved) or `in-progress` (rejected) |

Every issue runs the full spec -> plan -> build -> QA path.

For each phase, in order:

1. **Compute the artifact path** as an absolute scratch path: `<root>/<issue>/spec.md`, `.../plan.md`, `.../build.md`, `.../qa.md`.
2. **Resolve dependency read-paths** per `${CLAUDE_PLUGIN_ROOT}/references/pipeline/depends-on.md`. This pipeline resolves a dependency's `spec.md` and `plan.md`; there is **no archive fallback** (the hidden root has no `archive/`).
3. **Invoke the phase agent** with a `schema` forcing the structured return object. Hand it: the issue number, the exact absolute path to write its artifact to, the read-only upstream/dependency paths, and, in `auto` mode, the instruction to adopt its own recommended default and record the decision in the artifact. The agent never posts to GitHub; only the builder touches the PR, and only to open it as a draft placeholder. Tell the builder explicitly that **you own the pull request body**, so it opens the PR with only a minimal `Closes #<issue>` placeholder body and never `gh pr edit`s the body itself.
4. **On a `clarification-needed` return** (only in `semi-auto`/`manual`): follow the raising-questions reference, then re-invoke this same phase agent with the answer folded in. For spec/plan, if the question is still unresolved when you post, render a `[NEEDS CLARIFICATION]` block into the posted comment.
5. **On a `done` return**: read the artifact back from the scratch path to confirm it exists and is non-empty, then **deliver it to GitHub** for this phase (see "Delivering an artifact to GitHub"). For QA, parse the trailing `QA-VERDICT:` line from `qa.md` itself and record it in `state.json.qaVerdict`.
6. **Artifact-approval gate** per `${CLAUDE_PLUGIN_ROOT}/references/pipeline/modes.md`: in `manual` mode, stop for an approve/revise decision before advancing; in `auto`/`semi-auto`, advance immediately after delivering.
7. **Advance the status** by shelling out to the transition script (state-and-setup reference), then re-read `state.json.status` and continue.

### Build phase specifics

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/build-phase.md` for the dedicated branch, isolated worktree, entry transition, and PR-number caching. This pipeline's deltas:

- **You own the PR body**, so when you hand the builder the worktree path, tell it to open the PR with only a minimal `Closes #<issue>` placeholder body and never edit the body itself. You build the body from `build.md`.
- **After the build agent returns, you deliver by rebuilding the whole PR body** from its parts (see "Assembling the pull request body"):
  - **First build round.** Snapshot `build.md` as this issue's base PR content (copy it to `<root>/<issue>/pr-content.md`), then assemble and write the body. At this point the body is just `Closes #<issue>` plus the base content; no QA block or `# Updates` section yet.
  - **Later rounds** (a QA-rejection fixup or a manual build-gate revise). Append this round to the issue's ordered round log: archive the fresh `build.md` as the next `## Changes` entry, then reassemble and rewrite the whole body. Never post a PR comment and never leave a stale body.

### QA phase specifics

- Read the verdict from the last `QA-VERDICT:` line of `qa.md`, not from the agent's return, and record it in `state.json.qaVerdict`. Then **deliver by rebuilding the PR body** (see "Assembling the pull request body"): the reviewer already shaped `qa.md` as the `# QA: Approved` / `# QA: Rejected` block (verdict header, short summary, `<details>` full report, trailing `<!-- QA-VERDICT: ... -->`), so you place it verbatim.
  - **First QA** (before any rejection): this block is the top-level QA block that sits directly under the base PR content. Record it as the current QA block and reassemble the body.
  - **Re-review** (after a rejection fixup): archive this block as the next `## QA` entry in the round log (pairing the `## Changes` entry from the build round it reviewed), then reassemble the body.
- In `auto`/`semi-auto`: on `rejected`, route `qa.md` plus the rejection back to the **build** agent as fixup feedback, transition `ai-review -> in-progress`, re-run build (which archives a `## Changes` round entry and rebuilds the body), transition back to `ai-review`, and re-run QA (which archives the matching `## QA` round entry and rebuilds the body). Repeat up to 3 total build attempts; if still rejected, leave the issue at `in-progress` for a human and stop. On `approved`, transition `ai-review -> human-review`.
- In `manual`: after rebuilding the body with the QA block, hit the QA approval gate (modes reference).
- **Flip the PR out of draft on the way into `human-review`** with `gh pr ready <pr>` (re-derive `<pr>` fresh), in every mode when the transition into `human-review` happens. Idempotent; a failure here is a soft warning. This is a PR-state change, not a body rewrite or a comment, so it stands apart from the body-assembly flow.

## The status list

Statuses are bare (no `status:` prefix): `open`, `spec-ready`, `ready-for-dev`, `in-progress`, `blocked`, `ai-review`, `human-review`, `closed`, and the four manual-mode gates `spec-awaiting-approval`, `plan-awaiting-approval`, `build-awaiting-approval`, `qa-awaiting-approval`. The transition script's edge table is the single source of truth for which edges are legal. Moving the machine is a local-`state.json` write only; **it is never a label write** (nothing here reads or edits any `status:*` label).

## Delivering an artifact to GitHub

Once a phase agent returns `done` and you have confirmed the scratch artifact is present and non-empty, deliver it. Always deliver via `--body-file` (write the full body to a temp file and pass that file), never an inlined `--body`: it keeps the (possibly large) artifact off the shell command line and avoids any quoting corruption of multi-line markdown. The two spec/plan phases post issue comments; the build and QA phases both write the **pull request body**, which you rebuild from parts.

- **spec / plan** -> a **tagged issue comment**. Build the temp body by writing a small header prefix (the phase tag, and the notify @-mention) then appending the scratch artifact verbatim. Prefix with the phase tag (`<!-- gh-pipeline:spec -->` or `<!-- gh-pipeline:plan -->`) and the mention, then the artifact. Post with `gh issue comment <issue> --body-file <file>`. On a revise round, edit the existing tagged comment in place instead: find the last comment carrying that phase's tag and `PATCH` its body, adding a short "What changed" note at the top.
- **build / QA** -> the **pull request body**. You never post a PR comment; every build summary and QA report lives in the body. Rebuild the whole body from its parts and write it with `gh pr edit <pr> --body-file <file>` (see "Assembling the pull request body").

The notify @-mention is a single configurable GitHub username pinged when a spec/plan artifact is posted or revised (GitHub auto-notifies the author, but an explicit mention is the reliable trigger). Fold it into the spec/plan comment header prefix; leave it out if none is configured. The PR body has no @-mention line: the builder's `gh pr create` already notifies the author, and later body rewrites should not re-ping on every round.

Delivering to GitHub is a plain comment/PR-body write. It is **not** a label write.

## Assembling the pull request body

The pull request body is a single document you own and rewrite in full on every build and QA delivery. Never post a PR comment and never edit it by hand-splicing text into the live body: always reassemble it from the issue's saved parts and overwrite it with `gh pr edit <pr> --body-file <file>`. Rewriting the whole body each time makes the result deterministic and resume-safe: the same parts always produce the same body, so a re-run, a retried round, or a resumed session cannot duplicate or half-write a section.

### The saved parts (all under `<root>/<issue>/`)

- `pr-content.md` -> the base PR content: a snapshot of the first build round's `build.md`, taken once when the PR is first opened. This is the "what this PR does" top section and does not change on later rounds.
- `qa.md` -> the current QA block (the reviewer's latest report, already shaped as the `# QA:` header + summary + `<details>` + trailing `<!-- QA-VERDICT: ... -->`). Overwritten by each QA run; the body always shows the latest verdict up top.
- The **round log**, an ordered set of per-round entries for the `# Updates` section. Store each round as a pair of numbered files: `round-<n>-changes.md` (a build round's `build.md`, archived when that rework round runs) and `round-<n>-qa.md` (the matching re-review's `qa.md`, archived when that re-review runs). `<n>` starts at 1 for the first rework round (the first QA rejection's fixup). Round 0 is the initial build + first QA and lives in the top sections, not the log. Archive by copying the fresh scratch file to its numbered name at the moment that round's phase delivers, then reassemble; the numbered files are the durable per-round record (the scratch `build.md`/`qa.md` get overwritten each round).

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

- **`Closes #<issue>` always leads the body**, so the overlay never strips the issue link the `closedByPullRequestsReferences` lookup relies on (see the finding-pr reference).
- **The QA block only appears once QA has run.** On the very first build delivery (before any QA), there is no `qa.md` yet, so the body is just `Closes` + `pr-content.md`.
- **The `# Updates` section only appears once at least one rework round exists** (i.e. there is a `round-1-*` entry). Before the first QA rejection there are no rework rounds, so omit `# Updates` entirely.
- **A round's `## QA` may lag its `## Changes` by one delivery.** A build rework round archives `round-<n>-changes.md` and rebuilds the body before its re-review has run; at that instant `round-<n>-qa.md` does not exist yet, so render the `## Changes` entry with no `## QA` under it. The next QA delivery archives `round-<n>-qa.md` and rebuilds again, filling it in.

## Rendering a clarification block

When a spec/plan agent's `clarification-needed` return is still unresolved at the moment you post (only possible if you could not get an inline answer, e.g. a background session where the prompt never surfaced), render a visibility block at the top of the posted comment so a human sees it on the issue:

```
[NEEDS CLARIFICATION] <the exact question>

Options:
1. <label> (recommended default): <description>
2. <label>: <description>
...
```

List the recommended default first, matching the agents' contract. In a foreground session you will normally have resolved it inline before posting, so no block is needed; the block is the fallback for a question that could not be answered, and only when you also persisted the question in `state.json.pendingQuestion` and stopped (see the raising-questions reference). It is a courtesy for a human reading the issue, not a substitute for the local pending-question record.

## Modes

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/modes.md`. This pipeline's delta is only in *how* a `manual` revise re-delivers: spec/plan edit the existing tagged comment in place with a "What changed" note; a build revise is treated as a rework round (archive a `## Changes` round entry and rebuild the PR body); the QA-gate revise routes the feedback plus the current `qa.md` to the **build** agent, which archives a `## Changes` round entry and rebuilds the body, then re-runs QA (archiving the matching `## QA` round entry and rebuilding again) and stays at the QA gate.

## Finding the linked PR

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/finding-pr.md` (only the GitHub-issue path applies; this pipeline has no local issues).

## Anti-patterns

- Reading or writing **any GitHub label**. This skill never runs `gh issue view --json labels`, never `gh issue edit --add-label`/`--remove-label`, never uses a `status:`-prefixed status, and never infers state from a label. State lives only in `state.json`. This is the whole reason the skill exists.
- Letting a phase agent post to GitHub. The agents are file-only (the builder alone touches the PR, and only to open it as a draft with a minimal `Closes #<issue>` placeholder body); reading the scratch artifact back and delivering it is your job.
- Posting via an inlined `--body` (shell-quoting corrupts multi-line markdown) instead of `--body-file`. Always build the body on disk and post the file.
- Posting a PR comment for the build summary, the QA report, or a rework round. There are no PR comments in this pipeline: the build summary, the QA report, and every rework round all live in the PR body, which you rebuild from parts and overwrite with `gh pr edit --body-file`.
- Hand-splicing new text into the live PR body, or letting stale rounds survive because you only appended. Always reassemble the whole body from the saved parts (`pr-content.md`, `qa.md`, the `round-<n>-*` log) and overwrite it.
- Trusting an agent's "I wrote the file" over reading the file back; trusting the agent's summary of a QA verdict over the `QA-VERDICT:` line in `qa.md`.
- Writing `state.json` or a scratch artifact inside the repo tree, or `git add`ing it. State and scratch live under `~/.claude/dev-crew/`, outside the checkout, by construction.
- Launching multiple issues from here. This skill drives exactly one issue; a fleet is several independent background sessions, each its own `/run-pipeline-gh` run.

(The shared hard rules, persist-the-question-before-asking, stop-on-no-answer, only-the-script-moves-status, self-contained `AskUserQuestion` calls, live in the reference files above and bind here too.)

## Done criteria

The issue has advanced to its next resting point: each phase run's artifact delivered to its GitHub target (spec/plan as tagged issue comments; the build summary, QA report, and every rework round assembled into the PR body, which was rebuilt from its saved parts and overwritten via `gh pr edit --body-file`, never a PR comment), the state moved only through the transition script (a local `state.json.status`, never a label), any open question persisted in `state.json.pendingQuestion` (and, if it could not be answered, also rendered as a `[NEEDS CLARIFICATION]` block in the posted spec/plan comment) with nothing else recording it, and the agents having written only their scratch artifacts. No GitHub label was read or written at any point. A re-run reads `state.json` and resumes exactly where this one stopped.
