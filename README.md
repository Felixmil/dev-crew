# dev-crew

Spec, planner, build, and QA subagents modeled on [OpenDucktor](https://github.com/Maxsky5/openducktor)'s agent workflow, adapted to run as Claude Code subagents against a GitHub issue instead of OpenDucktor's own task store.

## What's here

The plugin ships one crew of agents and three pipeline skills that drive an issue through plan, build, and QA behind a first phase that is either spec (features) or investigate (bugs). All three pipelines are in-session skills that run the phase loop in the session's own context and drive the same crew; they differ in where state lives, where artifacts are delivered, and whether the first phase writes a spec or an investigation.

```
agents/                            six subagent definitions, one per job
  spec-writer.md                   turns an issue into a repo-grounded spec.md
  investigator.md                  turns a bug report into a repo-grounded investigation.md (reproduction, root cause)
  planner.md                       turns the spec/investigation into an ordered plan.md
  builder.md                       implements the plan, opens the PR as a draft, writes build.md
  reviewer.md                      reviews the PR against spec/plan, writes qa.md with a verdict
  conflict-resolver.md             resolves git merge/rebase conflicts, escalates semantic ones
skills/
  run-pipeline/                    /run-pipeline N [mode]: file-based pipeline; state and artifacts on disk
  run-pipeline-gh/                 /run-pipeline-gh N [mode]: gh-posting pipeline; state hidden and local, artifacts on GitHub
  debug-pipeline/                  /debug-pipeline N [mode]: bug pipeline; investigate replaces spec, QA checks the regression test
  refine-issue/                    /refine-issue N: interrogate a raw issue before spec work starts
  create-local-issue/              /create-local-issue: make a filesystem-only issue (L1, L2, ...) with no GitHub issue
  update-branch/                   /update-branch [branch]: merge the target in, ask only about semantic conflicts
  address-pr/                      /address-pr N: fix a PR's CI failures and address its valid review comments
  merge-pr/                        /merge-pr N: squash-merge a PR after gating CI, mergeability, and rule bypass
scripts/
  pipeline-transition.sh           the only thing allowed to write state.json.status, used by all three pipelines
drafts/                            inactive; outside the plugin's discovered directories (see drafts/README.md)
```

The crew is five job-title agents (spec-writer, investigator, planner, builder, reviewer) plus the standalone conflict-resolver. Each agent is lean and file-based: it writes its artifact to a path it is handed and returns a structured result, and it never posts to GitHub. The calling skill decides where the artifact goes, where state lives, and whether the first phase writes a spec or an investigation, which is what distinguishes the three pipelines:

- **The file-based pipeline** (`skills/run-pipeline/`) keeps state in a local `state.json` and leaves every artifact on the local filesystem under `<repo>.issues/<issue>/`. Nothing is posted to the issue thread.
- **The gh-posting pipeline** (`skills/run-pipeline-gh/`) keeps state in a local `state.json` under `~/.claude/dev-crew/<repo>/<issue>/` and delivers every artifact to GitHub: spec and plan as tagged issue comments, the build summary as the pull request body, QA as a tagged pull request comment.
- **The bug pipeline** (`skills/debug-pipeline/`) is the file-based pipeline with the spec phase replaced by an investigate phase (the `investigator` writes `investigation.md`) and a bug-aware QA. It shares the file-based pipeline's `<repo>.issues/<issue>/` root.

All three pipelines handle every human decision inline through `AskUserQuestion`. None reads or writes a GitHub label, so all run in repos where `status:*` labels are unavailable or you lack rights to create them.

## Installation

Install the plugin:

```
/plugin marketplace add ~/Code/dev-crew
/plugin install dev-crew@dev-crew
```

The marketplace path is the on-disk repo directory; the plugin and marketplace are both named `dev-crew`. After you install it, the six agents (`spec-writer`, `investigator`, `planner`, `builder`, `reviewer`, `conflict-resolver`) are available as `subagent_type`, and every skill (`/run-pipeline`, `/run-pipeline-gh`, `/debug-pipeline`, `/refine-issue`, `/create-local-issue`, `/update-branch`, `/address-pr`, `/merge-pr`) is available in every project.

The transition script both pipelines use (`scripts/pipeline-transition.sh`) ships inside the plugin and is invoked through the plugin-root path variable, `"${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-transition.sh"`, so it travels with the install and needs no copying into a target repo.

### Agent type names are plugin-prefixed

Claude Code namespaces plugin agents with the plugin name, so the agents register as `dev-crew:spec-writer`, `dev-crew:investigator`, `dev-crew:planner`, `dev-crew:builder`, `dev-crew:reviewer`, and `dev-crew:conflict-resolver`. The prefix avoids collisions with same-named agents from other plugins or from a project's own `.claude/agents/`. The skills call the agents by their prefixed names. If you call an agent directly, use the prefixed form; the bare name fails with an "agent type not found" error listing the registered names. A repo that installs the agents locally under its own `.claude/agents/` refers to them by bare name, for example `spec-writer`.

## The file-based pipeline

`skills/run-pipeline/SKILL.md` drives one issue through spec, plan, build, and QA while keeping everything local. Invoke it as `/run-pipeline <issue> [mode]`. It runs in the session's own context, reads and writes files directly, and asks every question inline through a multiple-choice prompt. It spawns the four file-writing agents for the heavy per-phase work and hands each one concrete filesystem paths.

The GitHub issue is the input, and a pull request is the ship channel. Nothing is posted to the issue thread, and no bookkeeping comment is added to the pull request. The four artifacts, the state machine, and every human question live on the local filesystem and in the running session.

### The `<repo>.issues/` layout

State lives next to the repo, never inside it. The skill derives the root from git: a repo whose working tree is at `~/Code/esqlabsR` gets a state root of `~/Code/esqlabsR.issues`, and each issue gets a folder under it:

```
~/Code/esqlabsR.issues/
  142/            an active issue: the pipeline is driving it, or it is waiting
    state.json    the pipeline state; the only file whose "status" is gated
    spec.md       written by spec-writer
    plan.md       written by planner
    build.md      the fuller build summary, a separate document from the PR body
    qa.md         the QA report, ending in one "QA-VERDICT: approved|rejected" line
  archive/        merged issues, moved out of the active set by /merge-pr
    128/          same five files, kept as a read-only record after the merge
      ...
```

A file's absence means that phase has not produced its artifact yet. When `/merge-pr` merges an issue's PR, it marks the issue `closed` and moves its folder into `archive/`, so the top level of `<repo>.issues/` holds only live issues while the merged ones stay on disk as a record (and as read-only context for anything that still `dependsOn` them). None of these files, and no `state.json`, is `git add`ed or posted to GitHub; they sit outside the repo tree by construction. All worktrees of one repo share a single `<repo>.issues` root, so an issue's state is the same wherever you drive it from.

`state.json` records the bare `status` (no `status:` prefix), the `mode`, the linked `prNumber` (a cache, re-derived fresh before it is trusted), the last `qaVerdict`, a `pendingQuestion`, and a `dependsOn` list. An open question lives only in `state.json.pendingQuestion`. An artifact is written only after every question is answered, so a run stopped mid-question leaves the persisted question and no partial artifact.

### Three modes on two orthogonal axes

Mode is `auto`, `semi-auto` (the default when you pass no mode word), or `manual`. Two independent decisions are gated separately:

- **Questions axis** (does an agent's raised ambiguity get surfaced?): `auto` never surfaces one, and the agent adopts its own recommended default and records that decision in the artifact. `semi-auto` and `manual` surface a genuine ambiguity inline as a multiple-choice question.
- **Artifact-approval axis** (does the skill stop after writing an artifact?): `auto` and `semi-auto` approve and advance immediately. `manual` stops after every phase for an inline approve or revise decision; `revise` re-runs that phase's agent with the feedback and rewrites the artifact in place, `approve` advances.

The axes are independent: a spec with no question in `semi-auto` still auto-approves, and the same spec in `manual` still stops for approval even when no question was raised. A bare `/run-pipeline 142` runs `semi-auto`: it surfaces a real ambiguity but auto-approves clean artifacts.

The QA-gate `revise` in `manual` routes the feedback plus the current `qa.md` to the builder rather than back to the reviewer, because QA's rejection reasoning belongs in the code. In `auto` and `semi-auto`, a QA rejection loops back into build, up to three total build attempts, before leaving the issue at `in-progress` for a human.

The builder opens the pull request as a **draft**, and it stays draft through every build/QA rework round. Only when QA approves and the issue reaches `human-review` does the pipeline flip it to ready for review (`gh pr ready`), so a PR still churning is never presented as ready.

### Resumability: the question survives the session

The pipeline reads where it is from `state.json` (`status` plus `pendingQuestion`), never from what the session remembers. Every question is persisted to `state.json.pendingQuestion` before it is asked, and cleared only once answered. A killed, slept, or closed session loses nothing: the first thing a re-run does, before touching any phase, is re-ask whatever question `pendingQuestion` holds, then route the answer as if it had been raised. Because artifacts are written only after questions are answered, there is no half-written file to reconcile.

Background sessions impose one rule: the skill never prints decision context as prose before asking. Everything the human needs lives inside the question and its options, because text emitted just before an inline question can be dropped in a background session, so a self-contained question is the only kind that reliably survives.

### `dependsOn`: read-only, one-directional

`state.json.dependsOn` is a list of issue numbers this issue may read from, in one direction. Set it explicitly, by hand at dispatch or by writing the field; the skill never auto-derives it. When it is set, the skill hands the phase agents the depended-on issues' `spec.md`/`plan.md` as read-only paths and no other issue's paths; when it is empty, no other-issue path is passed. One-directionality is structural: the agent for issue 142 is never told where 143 could be written. If a depended-on issue's artifacts do not exist yet when they would be read, the skill asks whether to proceed without the missing dependency (the recommended default) or wait, rather than proceeding silently or hard-blocking.

### A fleet is several background sessions

This skill drives exactly one issue; it has no multi-issue launcher. A fleet is several `/run-pipeline` runs dispatched as independent background sessions, each its own full Claude Code conversation with its own agent-view row. A question in one shows as "Needs input" and is answerable inline from agent view without affecting the others.

Inline questions come with two constraints worth understanding before you dispatch a fleet. First, an inline question has a fixed timeout of about 60 seconds, after which the model is told there was no answer and to proceed on its own judgment; the timeout is not configurable, and an answer given after it fires does not reach the run. Second, in a background session the prompt might not surface to you at all. The skill guards against proceeding on an unchosen default: on any unanswered or timed-out question it stops with the question still recorded in `state.json.pendingQuestion` and the status unchanged, so a re-run re-asks the exact question. It never adopts a default for a question it raised.

The recommendation follows: run `manual` and `semi-auto` issues in the foreground, where you see the question and the 60-second window is a non-issue in practice, and reserve background dispatch for `auto` runs, which raise no question. You can run a `semi-auto` or `manual` issue in the background, and the persist-then-stop behavior keeps it correct if a question is missed, but you might have to re-run it once you notice the "Needs input" row.

## The bug pipeline

`skills/debug-pipeline/SKILL.md` is the bug counterpart to the file-based pipeline. Invoke it as `/debug-pipeline <issue> [mode]`. It drives one bug through `investigate -> plan -> build -> QA`, keeping everything local under the same `<repo>.issues/<issue>/` root and driving the same crew, with two differences from `/run-pipeline`: the spec phase is replaced by an investigate phase, and QA is bug-aware.

The **investigate** phase runs a new `investigator` agent that writes `investigation.md` instead of `spec.md`. Its job is diagnosis, not requirements: it reproduces the bug (running the failing command or test), traces it to a root cause with `file:line` citations, assesses the fix's blast radius, and proposes a regression test. The last line of `investigation.md` is a verdict, `INVESTIGATION-VERDICT: bug-confirmed | not-a-bug | cannot-reproduce`, read from the file rather than the agent's return, the same convention the QA phase uses for `qa.md`. A malformed final line reads as `cannot-reproduce`, never `bug-confirmed`, so a garbled verdict can never silently drive a fix.

A `bug-confirmed` verdict advances to plan and the rest of the pipeline runs exactly as the feature pipeline does, with the planner, builder, and reviewer handed `investigation.md` where they would otherwise get `spec.md`. A `not-a-bug` or `cannot-reproduce` verdict is an **early exit**: the skill surfaces the finding and stops at a terminal `not-a-bug` status before any plan or build work. The issue folder is not auto-archived on an early exit; move it out of the active set by hand if you want.

QA is made **bug-aware** through the reviewer's prompt, not a separate agent: the skill hands the existing reviewer `investigation.md` alongside `plan.md` and one extra instruction, to verify from the diff that a regression test exists and covers the root cause cited in `investigation.md`, rejecting the fix if it does not. The reviewer reasons from the diff and does not re-run the reproduction (its tooling is read-only). The reviewer's `QA-VERDICT: approved|rejected` convention is unchanged.

Everything else matches the file-based pipeline: the same state root and archive, the three modes on the same two orthogonal axes (with the investigate manual gate offering a confirm-early-exit branch on a `not-a-bug` verdict), the resumable `pendingQuestion` flow, `dependsOn` (which spans bugs and features, since both share one root), local `L`-prefixed issues, and the stop at `human-review` for `/merge-pr` to finish. The shared `pipeline-transition.sh` gains a parallel bug entry segment (`open -> investigated`, an `investigate-awaiting-approval` gate, and the terminal `not-a-bug`) that rejoins the feature path at `ready-for-dev`; the feature pipeline never emits those statuses and the bug pipeline never emits `spec-ready`, so one script serves both without either wandering into the other's states.

## The gh-posting pipeline

`skills/run-pipeline-gh/SKILL.md` drives one GitHub issue through spec, plan, build, and QA, delivering every artifact to GitHub while keeping its state local. Invoke it as `/run-pipeline-gh <issue> [mode]`. It runs in the session's own context, spawns the four agents for the heavy per-phase work, and handles every human decision inline through `AskUserQuestion`. The agents write their artifacts to scratch files, and the skill posts them to GitHub.

### State lives locally, hidden, with no labels

The skill stores its state machine in a `state.json` under `~/.claude/dev-crew/<repo>/<issue>/`, moved only through `pipeline-transition.sh`, the same validated mutator the file-based pipeline uses. It reads and writes no `status:*` label, so it runs in repos where those labels are unavailable or you can't create them. The location is persistent, so a run paused with the machine off resumes cleanly, and it keeps the user's project directory free of a `<repo>.issues/` folder, since the artifacts live on GitHub.

### Where each artifact goes

Spec and plan are posted as tagged issue comments (`<!-- gh-pipeline:spec -->` and `<!-- gh-pipeline:plan -->`), because no pull request exists yet. The build's first-pass summary becomes the pull request body (`gh pr edit --body-file`); later build rounds reply as a pull request comment. QA is a tagged pull request comment (`<!-- gh-pipeline:qa -->`). Every post goes through `--body-file`, which writes the artifact to a temp file and posts from it and sidesteps shell-quoting problems on long markdown. The linked PR is re-derived each time through the `Closes #N` GraphQL lookup, never trusted from memory.

### Gates

The three modes work the same as in the file-based pipeline, on the same two axes: `auto` surfaces no question and auto-advances; `semi-auto` surfaces a genuine ambiguity inline but auto-advances artifacts; `manual` stops after each artifact for an inline approve or revise. A spec or plan agent that returns `clarification-needed` forces a gate in every mode, and the skill renders the question into the posted comment as a `[NEEDS CLARIFICATION]` block for visibility. A QA rejection loops the report back to the builder, up to three total build attempts, before leaving the issue at `in-progress`.

## refine-issue: sanity-check an issue before spec work

`skills/refine-issue/SKILL.md` interrogates a raw issue against the codebase before spec work starts. Invoke it as `/refine-issue <issue>`. It is standalone: no pipeline calls it, and the spec phase has no dependency on it.

It looks for two kinds of problems in one pass:

- **Open questions**: genuine ambiguity only you can resolve. The skill asks each one in conversation, one at a time with a recommended default, before it writes anything to GitHub. An unanswered question never reaches the issue.
- **Contradictions and incompatibilities**: places where the issue's ask conflicts with, duplicates, or cannot coexist with something the codebase already does, established with direct repo evidence (a file, a function, a test). The skill surfaces and acknowledges each in conversation.

Once everything is resolved, the skill edits the issue body in place (`gh issue edit --body`) and posts no comment. The original description stays untouched at the top; a single `<!-- refinement -->`-tagged section below it records the resolved decisions and reconciled contradictions, replaced in place on a re-run. If there is nothing to report, the skill says so in conversation and leaves the issue untouched. Everything it writes to the issue is already settled, so a pipeline never has an open question to scan for.

## Local issues: drive the pipeline without a GitHub issue

Some work has no GitHub issue behind it: exploratory work, an unfiled refactor, a task that only makes sense locally. `skills/create-local-issue/SKILL.md` makes a local issue, a per-issue folder under `<repo>.issues/` that the file-based pipeline and `refine-issue` treat like a GitHub-backed issue without touching GitHub.

Invoke `/create-local-issue` with an optional title and description. It:

- derives the git-based state root the pipeline uses (`<parent>/<repo>.issues`);
- assigns an `L`-prefixed id (`L1`, `L2`, ...) by scanning existing `L#` folders and taking the highest number plus one, so a local id never collides with a numeric GitHub issue number sharing the folder;
- writes `<root>/<id>/issue.md` holding the title and description, the local stand-in for a GitHub issue body;
- seeds `state.json` with `status: open`, `local: true`, and the standard fields.

A local issue is then first-class:

- **Refine it**: `/refine-issue L3` reads `issue.md` instead of `gh issue view` and writes the `<!-- refinement -->` section back into `issue.md`. Nothing goes to GitHub.
- **Run the pipeline**: `/run-pipeline L3`, in any mode. The pipeline detects the `L` prefix and adapts in three places: the phase agents read `issue.md` instead of `gh issue view`; the transition script makes no `gh` call for a local id; and the build phase opens a real pull request whose body references the local id in text rather than `Closes #N`, with the linked PR found by branch rather than by a `Closes` link.

Everything else (`state.json`, the four artifacts, the three modes, the gates, resumability, `dependsOn`) matches a GitHub-backed issue. A local issue ships as a pull request; only the issue side of the flow is local.

## update-branch: bring a branch up to date with its target

Running several issues at once means branches drift behind the base branch and pick up conflicts when they finally merge. `skills/update-branch/SKILL.md` brings a branch current by **merging its target in** (never a rebase, so review threads and comment anchors survive), and only when that merge conflicts does it drive `agents/conflict-resolver.md` on the same "resolve the safe part, ask about the risky part" principle the pipeline agents use. Invoke it as `/update-branch` (the current branch), `/update-branch <branch>`, `/update-branch <branch> onto <target>` to pick the target, or add an issue number so the resolver gets that issue's `spec.md`/`plan.md` for intent. `/address-pr` calls it first, to avoid chasing failures the target already fixed; no other pipeline calls it.

The division of labor is the point, because the dangerous failure is a wrong merge that still compiles:

- The agent auto-resolves only conflicts it can prove are safe: both sides made the same change expressed differently, one side is a pure superset of the other, both sides added disjoint independent code, or the difference is purely formatting or import order. If it cannot state in one sentence why a resolution is safe, it does not treat it as safe.
- For a genuine semantic conflict (both sides changed the same behavior incompatibly, two different implementations, two different constant values, overlapping edits to the same logic), the agent returns a structured `clarification-needed` naming the file and what each side does. The skill surfaces that inline through `AskUserQuestion` (take side A, take side B, or combine), then re-invokes the agent with your decision. It escalates each such conflict in turn until none remain.

After the last conflict is resolved, the agent verifies the merged result by running the repo's build and the relevant tests; a merge that breaks a test is not resolved. It leaves a clean, staged, verified tree and does not continue the rebase or commit for you, so you decide when to run `git rebase --continue`, commit, and push. If a question goes unanswered, the run stops with the safe hunks staged and the hard conflict still marked, so a re-run picks up there.

## address-pr: bring an open PR back to green and to a resolved review state

Two things tend to need attention on an open pull request before it can merge: red CI and reviewer comments. `skills/address-pr/SKILL.md` handles both. Invoke it as `/address-pr <PR>`, with optional free-form steering (for example, `/address-pr 42 only the failing R-CMD-check` or `/address-pr 42 focus on the error-handling comment`). With no steering it detects what the PR needs and does whatever applies.

It grounds its judgment in the issue's agreed spec and plan. You invoke it with a PR number, but the spec and plan live under `<repo>.issues/<issue>/`, so it maps PR to issue by finding the issue folder whose `state.json.prNumber` matches the PR, with the PR body's `Closes #N` or local `L`-id as a fallback. If it finds no spec or plan (a PR made outside the pipeline), it says so and judges on code merit alone rather than inventing a contract.

**CI failures.** It reads the failing checks (`gh pr checks`, `gh run view --log-failed`), diagnoses the root cause per check, and distinguishes a real code defect from an infra or flaky failure; it does not change working code for a timeout or a runner hiccup. For a genuine defect it delegates the fix to the `builder` agent, which pushes to the PR branch, then re-checks toward green, bounded so it does not thrash. It escalates an ambiguous or behavior-changing fix to you before it pushes.

**Review comments.** It classifies each comment against both the code and the spec and plan, then acts by category: a clearly-valid mechanical fix (a real bug, a typo, a missing test) or a genuine spec/plan violation gets fixed; an invalid or misguided comment is skipped with a specific reason; a comment that would exceed the PR's committed scope is skipped as out-of-scope with a follow-up suggestion; and a genuine judgment call, or a comment that reveals the spec or plan itself was wrong, is escalated to you through `AskUserQuestion`. It never treats a comment as an automatic instruction.

After pushing, it replies per comment on inline review threads (what changed, or why it was skipped) and posts one summary comment for general feedback, and it leaves the threads unresolved for the reviewer to close. All code changes go through the `builder` agent, so they meet the same quality bar as a pipeline build.

## merge-pr: squash-merge a PR after safety gates

`skills/merge-pr/SKILL.md` merges a finished pull request. Invoke it as `/merge-pr <pr>`. It takes a PR number and works on any PR, whether or not a dev-crew pipeline drove it. Merging is a standalone skill because it is an irreversible, outward-facing action that deserves its own gates; the pipelines stop at `human-review`.

Before it merges anything, it checks three gates and surfaces any red one to you through `AskUserQuestion`:

- **Mergeability** (`gh pr view --json mergeable,mergeStateStatus`): a `CONFLICTING` or `DIRTY` PR (conflicts) and a `BEHIND` one are handed back to you rather than force-merged; the `/update-branch` skill can bring a `BEHIND` branch current and resolve any conflicts the merge surfaces. A transient `UNKNOWN` is polled a few times before it is trusted.
- **CI** (`gh pr checks`): all-green passes; failing checks are named and you are asked whether to proceed; pending checks are not merged into without asking.
- **Branch-protection bypass**: if the PR is `BLOCKED` by branch protection and you are a repo administrator who could bypass with `--admin`, the skill asks explicitly before bypassing rules. If you are not an administrator, it stops and reports what is missing.

On success it runs `gh pr merge <pr> --squash --delete-branch`, adding `--admin` only when you authorized a bypass. `--delete-branch` removes the remote branch; the skill then cleans up the local side, best-effort and guarded, removing any worktree that held the head branch (at `<repo>.worktrees/<branch>` by convention, but found via `git worktree list`) and deleting the local branch, skipping with a warning on a dirty worktree, the worktree it is currently in, or a branch still checked out elsewhere. It also brings the local base branch up to date: when the checkout is on the PR's base branch (`baseRefName`) with a clean tree, it fast-forwards it to the merge commit with `git pull --ff-only`; if you are in a feature worktree, on another branch, or the tree is dirty, it skips with a warning rather than switching branches or risking a merge commit. If the PR maps to a pipeline issue (through `Closes #N` or a local `L`-id), it then marks that issue's `state.json` `closed` in whichever state root holds it (`<repo>.issues/` or `~/.claude/dev-crew/`), on a best-effort basis; for a file-based issue it also moves the issue folder into `<repo>.issues/archive/` so the active set holds only live issues (skipped if already archived). A PR that was not pipeline-driven merges with nothing to close.

## The state machine

All three pipelines share one state machine: state lives in a local `state.json` and moves only through `pipeline-transition.sh`. The `state.json` sits under `<repo>.issues/<issue>/` for the file-based and bug pipelines (next to the artifacts they keep on disk) and under `~/.claude/dev-crew/<repo>/<issue>/` for the gh-posting pipeline. The script enforces the transition table transcribed from OpenDucktor's `status-transition-policy.ts`, with bare statuses (no `status:` prefix). The feature path and the bug path share the same tail from `ready-for-dev` on, differing only in their first segment:

```
feature: open -> spec-ready ----\
                                  >-- ready-for-dev -> in-progress
bug:     open -> investigated ---/      -> ai-review -> human-review -> closed

bug early exit: open -> not-a-bug   (terminal)
```

Every feature issue runs the full spec, plan, build, and QA path; every bug runs investigate, plan, build, and QA, except that investigate may conclude the report is not a real bug and stop at the terminal `not-a-bug`. No agent and no skill writes `state.json.status` directly: only `pipeline-transition.sh` moves the machine, and it refuses any transition not in the table (a transition to the status already in effect is an idempotent no-op). The model that can be talked into anything never holds the pen that moves the state machine. The feature pipeline never emits `investigated`/`not-a-bug` and the bug pipeline never emits `spec-ready`, so a `state.json` belongs to whichever pipeline took its first edge; sharing one script does not let one skill wander into the other's states.

`manual` mode adds gate statuses to the table, one per phase: `spec-awaiting-approval` (features), `investigate-awaiting-approval` (bugs), `plan-awaiting-approval`, `build-awaiting-approval`, and `qa-awaiting-approval`. Each is entered from the status that precedes its phase and exits, on approve, to the real status that phase produces in `auto` mode.

Nothing here reads or writes a GitHub label, which is what lets the gh-posting pipeline run in repos where `status:*` labels are unavailable or you lack rights to create them: it posts artifacts to GitHub, but its state lives on your disk.

## Target repo prerequisites

All three pipelines need one thing, and no GitHub labels:

- The `gh` CLI, authenticated against the repo. The transition script ships with the plugin, so nothing is copied per repo.

The gh-posting pipeline also needs permission to comment on issues and PRs, edit the issue body, and push branches and open PRs, to deliver its artifacts. It needs no `status:*` labels and no label-edit rights. The file-based pipeline and the bug pipeline need no GitHub write permission beyond opening the pull request.

## Known gaps versus OpenDucktor

- No worktree isolation between build and QA by default. Pass `isolation: "worktree"` to the builder invocation in a pipeline if agents run concurrently and might collide.
- The QA verdict is a `QA-VERDICT: approved|rejected` string convention read from the last line of `qa.md`, not a typed tool call. A malformed final line reads as `rejected`.
- No cross-issue coherence check. Each issue is planned and built on its own; nothing detects two issues whose specs contradict each other. OpenDucktor's own state machine does not either, beyond blocking an epic from closing while a subtask is open.
- No canonical task-summary object. Each agent re-reads the full issue thread (or, for build and QA, the pull request thread) through `gh issue view --comments` or `gh pr view --json comments` rather than a cached document-presence summary.

## drafts/

The `drafts/` directory holds inactive files, outside the plugin's discovered directories (`agents/`, `skills/`, `scripts/`), so nothing loads or invokes them. It holds Workflow-script implementations of the two run-pipeline variants and the GitHub-label state mutator, kept for reference and as a reactivation path. See `drafts/README.md` for what each file is and how to reactivate it.
