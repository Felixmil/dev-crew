# Implementation plan: file-based issue pipeline (`/file-pipeline` skill)

## Overview

This plan turns the confirmed spec into an ordered build sequence for a new Claude Code **skill**, `/file-pipeline`, that drives one GitHub issue through spec -> plan -> build -> QA while keeping the four artifacts, the state machine, and all human interaction on the local filesystem and in the running session (the GitHub issue stays as input, a pull request stays as the ship channel). The skill runs in the session's own main context, so it reads and writes `<repo>.issues/<issue>/` directly and prompts inline via `AskUserQuestion`; it spawns four new file-writing subagents (forked from the existing gh-posting agents, which stay untouched) for the heavy per-phase reasoning, hands them concrete paths, and receives a structured "clarification needed" result instead of scanning a marker out of a comment. State lives in `state.json`, mutated only through a single validated transition step whose edge table is copied verbatim from `status-transition.sh`. The work is deliberately additive: nothing existing (`gh-pipeline.js`, `status-transition.sh`, the four agents, `refine-issue`) is modified.

## Verified tooling assumptions

All four capability claims the spec rests on were checked against current Claude Code behavior/docs (via the claude-code-guide agent) before relying on them:

1. **A skill runs in the main session's context — TRUE.** A skill's rendered `SKILL.md` enters the ongoing conversation as a message and stays for the session; it is *not* an isolated subagent. So the skill can call `AskUserQuestion` and use `Read`/`Write`/`Edit`/`Bash` directly, no subagent-brokering of filesystem I/O. (Source: skills docs, "Skill content lifecycle".) This is the load-bearing assumption for FR-LOC-5 and the whole inline-question design; it holds.
2. **Subagents cannot call `AskUserQuestion` — TRUE.** `AskUserQuestion` (along with `EnterPlanMode`/`ExitPlanMode`/`ScheduleWakeup`/`WaitForMcpServers`) is explicitly on the list of tools unavailable to subagents because they depend on the main conversation's UI, even if listed in the subagent's `tools`. So a worker subagent is strictly non-interactive and must return a structured "clarification needed" result for the skill to prompt on. (Source: tools-reference / subagents docs.) This is exactly what FR-ART-6 assumes; it holds.
3. **A background session is a full Claude conversation that can pause on `AskUserQuestion`, be answered inline from agent view, and resume — TRUE.** Each background session is a complete Claude Code conversation (not a subagent); agent view shows a "Needs input" row, the peek panel (`Space`) shows the multiple-choice options, and a number key answers it inline, after which the session resumes. (Source: agent-view docs, "Peek and reply".) This is what the "fleet = N independent background sessions" model in the spec depends on; it holds.
4. **Known limitation on inline prompting from background sessions — real, corroborated, does not block.** The happy-path docs describe answering a background session's question inline, but a targeted issue-tracker search corroborates the spec author's stated concern: there are current, open reports of background/daemon sessions mishandling `AskUserQuestion`. Two failure modes matter for this design: (a) assistant **text emitted just before** an `AskUserQuestion` call in a background session can be dropped from the transcript, so any *context* the skill prints before asking may never reach the human; and (b) in fully headless/print mode the model may continue on assumptions instead of stopping at the question. An older "agent-view row stays "working" instead of showing "needs input"" report appears fixed, but edge cases remain. This confirms rather than overturns the spec: inline-only was chosen eyes-open, so it does **not** block the build. It does impose one concrete design rule (carried into the control-flow section and Risks): **put the decision context inside the `AskUserQuestion` question/options, never in prose emitted before the call**, and lean on `pendingQuestion`-first persistence as the recovery path. (Specific issue numbers from the search are deliberately not cited here — they live outside this repo and this document must stay self-contained; the behavior is described instead.)
5. **A plugin's `skills/` directory is auto-discovered like `agents/` — TRUE.** Installing the plugin exposes the skill in every project with no per-repo copy and no `skills` field in `plugin.json` (the default `skills/` directory is always scanned); the skill is invoked namespaced as `/dev-crew:file-pipeline`. (Source: plugins-reference.) This makes the install one plugin plus a one-file transition-script copy, simpler than the original workflow's two-path install; see the resolved risk and work item 4.

## Naming (satisfies FR-ART-1, constraint "no openducktor/odt in new names", acceptance 10)

New identifiers, none containing "openducktor" or "odt":

| Thing | Name |
| --- | --- |
| Skill (dir + invocation) | dir `skills/run-pipeline/`; invoked namespaced as `/dev-crew:file-pipeline` (this plan and the spec write it as the shorthand `/file-pipeline` throughout; both resolve to the same skill) |
| Spec agent | `spec-writer` |
| Plan agent | `planner` |
| Build agent | `builder` |
| QA agent | `reviewer` |
| Transition script | `.claude/scripts/issue-state-transition.sh` |
| State root | `<repo>.issues/` (derived, not a literal name to invent) |

Plugin-namespaced agent types (per the existing plugin prefix convention) are `dev-crew:spec-writer`, etc. The plugin *package* name (`dev-crew`) is a pre-existing identifier and is out of scope to rename; the constraint is about **new** names, and the prefix is how Claude Code namespaces plugin agents. The only place the literal "OpenDucktor"/"odt" text may appear in new files is a lineage comment at the transition table (FR-STATE-1).

## Ordered work items (dependency order)

Each item lists the files it creates/changes, what it does, why it fits, how to verify, and the FR-ids it satisfies. Items are ordered so each depends only on earlier ones.

### 1. Transition script `issue-state-transition.sh` (state machine mutator)

- **Creates:** `.claude/scripts/issue-state-transition.sh` (in this plugin repo; copied per-target-repo like `status-transition.sh` is).
- **What:** A bash script `issue-state-transition.sh <issues-root> <issue> <to-status>` that (a) reads the issue's current `status` from `<issues-root>/<issue>/state.json` (treating a missing file/field as `open`), (b) reads the `type:task`/`type:bug` signal *from GitHub* (`gh issue view <issue> --json labels`, read-only, exactly as the original does — FR-STATE-4), (c) checks `current -> to` against an `allowed()` case-statement whose body is **copied character-for-character** from `status-transition.sh` (same states, same edges, same `is_task` shortcut, same four `*-awaiting-approval` gate edges), and (d) only on success writes the new `status` back into `state.json` (via a `jq` read-modify-write to a temp file, then atomic move), leaving every other field untouched. An illegal transition prints `Transition not allowed: <current> -> <to>` to stderr and exits non-zero **without** mutating the file.
- **Why it fits:** FR-STATE-1 says reuse the table verbatim; the *edges* are what's reused, but the *storage* changes from a GitHub label to a `state.json` field (the table's own note: "Only the storage changes"). Keeping the edge list byte-identical (with a lineage comment citing OpenDucktor's `status-transition-policy.ts`, the sole surviving use of that name) makes drift impossible to introduce silently. Keeping it a bash script (not inlined into the skill prose) preserves the original's property that a single, auditable, non-model step is the only thing that moves the machine (FR-STATE-2). Reading `is_task` from GitHub, not from local state, matches FR-STATE-4 (the skip-spec shortcut still reads type labels; writes nothing back).
- **Status vocabulary is stored bare** (`open`, `spec-ready`, ... , `spec-awaiting-approval`, ...), without the `status:` prefix the labels carried, since there is no label namespace to disambiguate in a JSON field. The edge table's left/right sides are transcribed with the prefix stripped consistently on both sides so the comparisons still match one-to-one. (This is a mechanical prefix strip, not an edit to the edge set.)
- **How to verify:** From a scratch dir, seed `state.json` with `{"status":"open"}`; run the script for a legal edge (`open -> spec-ready`) and confirm `state.json.status` updates and nothing else changes; run an illegal edge (`open -> ai-review`) and confirm non-zero exit, stderr message, and an **unchanged** file. Diff the `allowed()` body against `status-transition.sh`'s to prove the edge set is identical modulo the prefix strip. Confirm `type:task` seeded on the GitHub test issue enables `open -> in-progress`.
- **Satisfies:** FR-STATE-1, FR-STATE-2, FR-STATE-4 (partial: the read side).

### 2. The four file-writing agents

- **Creates:** `agents/spec-writer.md`, `agents/planner.md`, `agents/builder.md`, `agents/reviewer.md`.
- **What:** Four subagent definitions forked from `spec-agent`/`planner-agent`/`build-agent`/`qa-agent`, changed so each **writes its artifact to a filesystem path it is handed** and, for spec/plan, **returns a structured "clarification needed" result instead of ever writing a `[NEEDS CLARIFICATION]` marker**. Detailed per-agent deltas are in the "Four new file-writing agents" section below. No `model:` frontmatter (inherit session model — FR-ART-1). Tool frontmatter changes: drop `Bash(gh issue comment *)` from spec/plan (they no longer post), add `Write`/`Edit` to spec/plan (they now write local files), keep the PR-related `gh` tools on build/QA, drop `Bash(gh pr comment *)` from build and QA (no bookkeeping comments — FR-SHIP-3/FR-ART-3/FR-ART-4).
- **Why it fits:** FR-ART-1/2/3/4/6. The agents are the heavy reasoning; forking (not editing the originals) keeps the coexistence guarantee (Non-goals, acceptance 10).
- **Depends on:** nothing in this repo, but conceptually pairs with item 3 (the skill hands them paths). Built before the skill so the skill can reference concrete agent types and the exact structured-return shape.
- **How to verify:** Install the plugin locally (`/plugin marketplace add`, `/plugin install`), confirm the four new `subagent_type`s resolve under the `dev-crew:` prefix; unit-invoke `spec-writer` against a throwaway issue with a handed path and confirm it either writes a clean `spec.md` at that path or returns the clarification object (never writes a marker).
- **Satisfies:** FR-ART-1, FR-ART-2, FR-ART-3, FR-ART-4, FR-ART-6, FR-SHIP-1, FR-SHIP-2, FR-SHIP-3.

### 3. The skill `SKILL.md` (the phase loop, run in the session)

- **Creates:** `skills/run-pipeline/SKILL.md`.
- **What:** The orchestration, written as instructions the session executes directly (matching `refine-issue`'s SKILL.md shape: YAML frontmatter with `name` + a trigger-describing `description`, then a `# Issue pipeline` body with Mission / Workflow / Anti-patterns / Done sections). It:
  1. Parses `<issue> [mode]` (mode default `semi-auto`; also accepts the terminal `merge` action) — FR-MODE-5, FR-SHIP-4.
  2. Derives the state root from git (`git rev-parse --git-common-dir`; parent basename = repo name; root = `<parent-of-repo>/<repo>.issues`) — FR-LOC-1/2.
  3. Ensures `<root>/<issue>/` exists and seeds `state.json` as `open` if absent (bootstrap) — FR-LOC-4, FR-STATE-3.
  4. **Before doing anything else, checks `state.json.pendingQuestion`; if non-null, re-asks it via `AskUserQuestion`, clears it on answer, and folds the answer into the phase re-invocation** — FR-RESUME-3.
  5. Runs the phase loop off `state.json.status` (never session memory — FR-RESUME-4): for each phase, invoke the phase agent with the concrete artifact path(s) and any dependency read-paths (FR-ISO-2); on a structured "clarification needed" return, write `pendingQuestion`, `AskUserQuestion`, clear it, re-invoke (FR-ART-6, FR-RESUME-1/2); on a clean return, read the artifact back (FR-ART-5), then either auto-advance (auto/semi-auto) or hit the manual artifact-approval gate (manual) — FR-MODE-1..4, FR-CLAR-2/3.
  6. Advances status only through item 1's script (single mutator).
  7. Handles the `merge` action as a standalone terminal path — FR-SHIP-4.
- **Why it fits:** The skill *is* the session context, so it owns every `AskUserQuestion` and every direct file read/write; subagents only do the heavy per-phase work. This is the core "why a skill, not a Workflow" rationale.
- **Depends on:** items 1 and 2.
- **How to verify:** The end-to-end checklist at the end of this plan (acceptance 1-12). Minimal smoke: `/run-pipeline <n> auto` on a fresh throwaway issue produces all four files + a linked PR and advances status with no issue-thread comments.
- **Satisfies:** FR-MODE-1..5, FR-LOC-1..5, FR-FILE-1..4, FR-RESUME-1..4, FR-ISO-1..5, FR-STATE-3, FR-ART-5, FR-CLAR-1..3, FR-SHIP-1..4.

### 4. Plugin registration + README section

- **Changes:** `README.md` (add an `/file-pipeline` section and list the four new agents, the skill, and the new script under "What's here"). No `plugin.json` change is required: `agents/` and `skills/` are both auto-discovered (confirmed against plugins-reference), so no `skills` manifest field is needed.
- **What:** Document the install: the plugin ships the skill **and** the four agents (auto-discovered, invoked as `/dev-crew:file-pipeline`), and only the transition **script** is copied per target repo (scripts are not plugin-discoverable, exactly like `status-transition.sh`). This is one plugin install plus a one-file script copy, simpler than the original workflow's two-path (copy-workflow-and-script) install. Also document the three modes on two axes, the `<repo>.issues/` layout, `dependsOn`, resumability, the fleet-via-agent-view model, and the execution-mode guidance from the resolved background-session risk (prefer foreground for `manual`/`semi-auto`, background for `auto`, until the background-session reports resolve). Explicitly state the coexistence with the gh-posting pipeline.
- **Why it fits:** Discoverability and the acceptance criterion that the target repo needs no `status:*` labels created (acceptance 9) must be documented so a user does not create them out of habit.
- **Depends on:** items 1-3.
- **How to verify:** A reader following only the README can install and run the skill against a fresh repo with only `gh` auth (and optional `type:*` labels).
- **Satisfies:** FR-STATE-4 (documentation half), acceptance 9, acceptance 10 (naming visible in docs).

## State model

### `state.json` schema

One file per issue at `<repo>.issues/<issue>/state.json`. All fields the spec names (FR-FILE-1), with `dependsOn` (FR-ISO) and `pendingQuestion` (FR-RESUME):

```jsonc
{
  // Current pipeline state. Bare status vocabulary (no "status:" prefix),
  // same set the transition table enforces.
  // One of: "open" | "spec-ready" | "ready-for-dev" | "in-progress"
  //       | "blocked" | "ai-review" | "human-review" | "closed"
  //       | "spec-awaiting-approval" | "plan-awaiting-approval"
  //       | "build-awaiting-approval" | "qa-awaiting-approval"
  "status": "open",

  // The mode this issue is driven in. "auto" | "semi-auto" | "manual".
  // Persisted so a resume re-run without a mode word keeps the issue's mode.
  "mode": "semi-auto",

  // The linked PR number once known, else null. Re-derived via findLinkedPr
  // when absent; persisted as a cache/record, never trusted over a fresh lookup.
  "prNumber": null,

  // The last QA verdict, else null. "approved" | "rejected" | null.
  "qaVerdict": null,

  // A question raised but not yet answered, else null. Sole persisted record
  // of an open question (no half-written artifact exists — FR-ART-2).
  "pendingQuestion": null,
  // when non-null:
  // {
  //   "phase": "spec" | "plan" | "build" | "qa" | "dependency",
  //   "question": "the exact question text",
  //   "options": [{ "label": "...", "description": "..." }, ...],  // recommended default first
  //   "recommendedDefault": "the label of the first/recommended option"
  // }

  // Issue numbers this issue depends on (read-only, one-directional). Default [].
  // Set explicitly only (human at dispatch, or written here) — never auto-derived.
  "dependsOn": []
}
```

Notes:
- **No `[NEEDS CLARIFICATION]` marker is ever persisted anywhere.** `pendingQuestion` is the only open-question record (FR-ART-6, acceptance 12).
- `spec.md` / `plan.md` / `build.md` / `qa.md` are siblings of `state.json`; a file's *absence* means that phase has not produced its artifact (FR-FILE-2). None of these files, nor `state.json`, is ever `git add`ed or posted to GitHub (FR-FILE-4) — they live outside the repo tree by construction (FR-LOC-1).

### The single validated status mutator

- **Where it lives:** `.claude/scripts/issue-state-transition.sh` (item 1). The skill's *only* way to change `status` is to shell out to this script; the skill never writes `state.json.status` with its own `jq`/`Write`. (The skill *does* directly write the other fields — `mode`, `prNumber`, `qaVerdict`, `pendingQuestion`, `dependsOn` — since those are not the state machine and have no transition rules; only `status` is gated.)
- **How it enforces:** reads current `status` from the file, validates `current -> to` against the verbatim edge table, writes only on success, exits non-zero and leaves the file untouched on an illegal edge (FR-STATE-2, "loud failure, no illegal writes"). The skill checks the script's exit code and treats a non-zero as a hard error (surfaced, not swallowed).
- **Lineage comment:** a comment at the table cites OpenDucktor's `status-transition-policy.ts` as the source of the edges — the only place that name survives (FR-STATE-1, constraint).

## Four new file-writing agents

All four are **forks** of the existing gh-posting agents; the originals are untouched (Non-goals). All inherit the session model (no `model:` frontmatter — FR-ART-1). Each is handed **concrete filesystem paths** by the skill and, for spec/plan, returns a **structured "clarification needed" result** instead of prompting (subagents cannot prompt — verified assumption 2).

The structured clarification return (spec/plan/build as applicable): the agent's final text is a JSON object the skill parses:

```jsonc
{
  "status": "clarification-needed" | "done",
  // when "clarification-needed":
  "question": "the exact question to ask the human",
  "options": [{ "label": "short choice", "description": "what it means" }, ...], // recommended default FIRST
  "recommendedDefault": "label of the recommended (first) option"
  // when "done": no extra fields; the artifact has been written to the handed path.
}
```

The skill enforces this via a `schema` on the `agent()`/Agent call, so the agent must return the object (not prose) — the same defensive-schema reasoning the original workflow used for its bookkeeping reads.

| Agent | Forked from | What it does *differently* | Tool frontmatter delta |
| --- | --- | --- | --- |
| `spec-writer` | `spec-agent` | Reads issue + repo; **writes `spec.md` to the handed path** instead of `gh issue comment`. On genuine ambiguity, **returns `clarification-needed`** (does not write a partial artifact, never writes a marker). Only when handed the answer (or in auto mode, told to adopt its own recommended default and record the decision in the spec) does it write a final clean `spec.md`. | Drop `Bash(gh issue comment *)`; add `Write`, `Edit`. Keep `Read`, `Grep`, `Glob`, `Bash(gh issue view *)`. |
| `planner` | `planner-agent` | Reads `spec.md` (handed path) + repo (+ any `dependsOn` artifact paths); **writes `plan.md`**. Same `clarification-needed` return contract as spec. | Drop `Bash(gh issue comment *)`; add `Write`, `Edit`. Keep read + `Bash(gh issue view *)`. |
| `builder` | `build-agent` | Implements the plan; **opens/updates the real PR with a clean repo-facing body** (`Closes #N`); **writes the fuller build summary to `build.md`** (handed path) instead of a PR comment. On later rounds (QA fixup, manual revise) pushes to the PR branch and updates `build.md`, **no per-round PR comment**. May also return `clarification-needed` if it hits a genuine ambiguity (rare; same contract). | Drop `Bash(gh pr comment *)`. Keep `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`, `Bash(gh issue view *)`, `Bash(gh pr create *)`, `Bash(gh pr view *)`; add `Bash(gh pr edit *)` for the body. |
| `reviewer` | `qa-agent` | Reviews the PR diff against **local `spec.md`/`plan.md`** (handed paths), **writes the QA report to `qa.md`** ending in exactly one `QA-VERDICT: approved|rejected` line, instead of a PR comment. | Drop `Bash(gh pr comment *)`. Keep `Read`, `Grep`, `Glob`, `Bash(git diff *)`, `Bash(git log *)`, `Bash(gh issue view *)`, `Bash(gh pr diff *)`, `Bash(gh pr view *)`. |

**How the skill hands paths and receives results:**
- The skill computes `<root>/<issue>/spec.md` etc. and passes them verbatim in the agent prompt ("write your spec to exactly `<abs-path>`"; "read the spec at exactly `<abs-path>`"). Because the skill runs in the session, it knows the real absolute paths (FR-LOC-5).
- For `dependsOn` (FR-ISO-2), the skill passes the depended-on issues' artifact paths (e.g. `<root>/143/spec.md`, `<root>/143/plan.md`) as **read-only** context in the prompt, and passes *no* path to any non-dependency issue's folder (FR-ISO-1/3). One-directionality is structural: 142's agent is simply never told where 143 could be written, and is never handed 142's paths when driving 143.
- The skill **reads each artifact back** from disk after a `done` return (FR-ART-5): confirms the file exists and, for QA, parses the trailing `QA-VERDICT:` line from the file (not from the agent's summary).

## Interactive / resumable control flow

This is the heart of the skill. Precise ordering:

### When `pendingQuestion` is written vs cleared (FR-RESUME-1/2)

1. Agent returns `clarification-needed` (or the dependency check finds a missing dep, or a manual gate needs an approve/revise decision — all three are "a question").
2. **Write `state.json.pendingQuestion`** = `{ phase, question, options, recommendedDefault }`. This happens *before* any prompt.
3. **Call `AskUserQuestion`** with those options (recommended default first, matching the numbered-option preference — FR-MODE-3). **All context the human needs to answer must live inside the question text and the option `label`/`description` fields — never in prose printed before the call.** This is a hard rule, not a stylistic one: background sessions can drop assistant text emitted immediately before an `AskUserQuestion` call (see Risks), so any context printed beforehand may never reach the human answering from agent view. Self-contained questions are immune to that failure mode.
4. On answer: **clear `pendingQuestion` to `null`**, then fold the answer into the next action (re-invoke the phase agent with the answer in its instructions — FR-RESUME-2; or, for a gate, take the approve/revise branch).
5. Because artifacts are written only *after* all questions are answered (FR-ART-2), the answer flows into the agent, never into an existing file. There is no half-written artifact to reconcile.

### How a re-run detects and re-asks a pending question first (FR-RESUME-3/4)

- The very first thing the skill does after loading `state.json` (before touching any phase) is: **if `pendingQuestion !== null`, re-ask that exact question** via `AskUserQuestion` (rebuilding the prompt from the persisted `phase`/`question`/`options`/`recommendedDefault`), clear it on answer, and route the answer as if it had just been raised, then continue the phase loop.
- "Where am I" is always derived from `state.json` (`status` + `pendingQuestion`), never from session memory (FR-RESUME-4). A killed/slept/closed session therefore loses nothing: the question survives in `state.json`, the artifact was never written, and the next run re-asks (acceptance 5, 12).

### How the mode axes gate questions vs artifact approval (FR-MODE-1..4, FR-CLAR-2/3)

Two independent decisions, evaluated separately:

- **Questions axis** (does an agent's raised ambiguity get surfaced?):
  - `auto`: never surfaced. The skill invokes the agent **told to adopt its own recommended default and record the decision in the artifact** (so the agent returns `done`, not `clarification-needed`). Nothing is written to `pendingQuestion`; nothing prompts (FR-MODE-2, FR-CLAR-2).
  - `semi-auto` / `manual`: a `clarification-needed` return is surfaced inline (the flow above) (FR-MODE-3).
- **Artifact-approval axis** (does the skill stop after a written artifact?):
  - `auto` / `semi-auto`: auto-approve every artifact; advance immediately (FR-MODE-4).
  - `manual`: after each phase's artifact is written and read back, **`AskUserQuestion` to approve or revise**. `revise` re-runs that phase's agent with the feedback, re-writes the artifact in place, asks again; `approve` advances via the transition script. The QA-gate `revise` routes feedback + current `qa.md` to the **build** agent (not QA), re-runs QA, re-writes `qa.md`, stays at the gate (edge case in spec). These gates use the `*-awaiting-approval` states in the transition table.
- The two axes are genuinely orthogonal (FR-CLAR-3): a spec with no question in semi-auto still auto-approves; the same spec in manual still stops for approval even though no question was raised.

### How `dependsOn` read-access and the missing-dependency prompt are wired (FR-ISO-2/5)

- Before invoking the spec/plan/build agents for issue N, the skill reads `state.json.dependsOn`. For each depended-on issue D, it resolves `<root>/D/spec.md` and `<root>/D/plan.md`.
- If those exist, it passes them as read-only paths in the agent prompt (FR-ISO-2). If `dependsOn` is empty, no other-issue path is ever passed (FR-ISO-1).
- If a depended-on `D`'s folder or artifacts **do not exist** at the point they'd be read: the skill does **not** silently proceed and does **not** hard-block. It surfaces the situation via `AskUserQuestion` — options "proceed without the missing dependency" (recommended default, so a bare run still moves) vs "wait" — and, being a question, it is persisted to `pendingQuestion` first, so a stop mid-decision recovers like any other (FR-ISO-5, edge case). If the human picks "wait", the skill stops cleanly (leaving `pendingQuestion` cleared but `status` unchanged) so a later re-run retries the dependency.

## Risks / open technical questions

- **Background-session `AskUserQuestion` reliability — RESOLVED (decision below).** The fleet model and inline-answer flow depend on a background session reliably pausing on `AskUserQuestion` and being answerable from agent view. An issue-tracker search corroborated the spec author's stated concern: there are current, open reports of background/daemon sessions (i) dropping assistant text emitted immediately before an `AskUserQuestion` call, and (ii) not stopping at the question in fully headless/print mode. The design does not depend on those being fixed. **Decision:** proceed exactly as the spec dictates (inline-only, background-based fleet; no fallback answer channel — that stays a Non-goal), with three concrete provisions:
  1. **Self-contained questions (code).** The skill never emits decision context as prose before an `AskUserQuestion` call; all of it lives inside the question text and the option `label`/`description` fields, so nothing the human needs can be dropped by failure mode (i). Stated as a rule in the control-flow section and to be written as an explicit anti-pattern in the SKILL.md.
  2. **`pendingQuestion`-first persistence (code, already required by FR-RESUME-1).** Because the question is persisted before the prompt, a stuck background session is recoverable: the human kills it and re-runs `/run-pipeline <issue>`, which re-asks the exact question in a fresh session. The resumability mechanism doubles as the mitigation, at no extra cost.
  3. **Execution-mode guidance (docs, not code).** The README recommends running `manual`/`semi-auto` issues in the **foreground** (where `AskUserQuestion` is unaffected by the background-session reports) and reserving background dispatch for `auto` runs (which never prompt), until those reports are resolved. This is guidance only; it is **not** enforced in code, because the spec's fleet model is explicitly background-session-based and provisions 1-2 make background inline answering safe enough to keep as the supported path. Enforcing a foreground requirement would contradict the spec's stated fleet design (acceptance 7), so it is deliberately left as advice.
  This closes the marker: the design ships as specified; the only added surface is one anti-pattern line in the SKILL.md and one guidance paragraph in the README.
- **Skill distribution/discovery — RESOLVED (confirmed against docs).** A plugin's `skills/` directory is auto-discovered exactly like `agents/`: installing the plugin makes the skill available in every project with no per-repo copy, and no `skills` field in `plugin.json` is needed (the default `skills/` directory is always scanned). The skill is invoked **namespaced** as `/dev-crew:file-pipeline`, the same prefixing the four agents get, not bare `/file-pipeline`. (Source: plugins-reference — skills are "automatically discovered when the plugin is installed"; the default `skills/` directory is always scanned; plugin `name` is used for namespacing components.) **Consequence for the build:** only the transition **script** copies per target repo (scripts are not plugin-discoverable, exactly like `status-transition.sh` today); the skill and the four agents all ship with the plugin. Item 4's README section documents a **one-path** install for everything plugin-borne (skill + agents) plus a one-file copy of the transition script, which is simpler than the two-path install the original workflow needs.
- **`merge` and the missing-PR / wrong-state cases** are handled by failing loudly (spec edge cases): `merge` refuses unless `status === human-review`; any phase needing a PR (QA, merge) fails with a clear message when `findLinkedPr` returns none. No ambiguity, listed for completeness.
- **Atomic `state.json` writes.** Concurrent writers to one issue's `state.json` are not expected (one issue per session), but the transition script should still write via temp-file-plus-rename to avoid a torn file if a session is killed mid-write. Low risk; noted so it isn't skipped.

## End-to-end verification checklist (maps to acceptance criteria 1-12)

1. `/run-pipeline <n> auto` on a fresh issue -> `spec.md`, `plan.md`, a real linked PR, `build.md`, `qa.md` under `~/Code/<repo>.issues/<n>/`; `state.json.status` walks the full sequence; no question surfaced; zero issue-thread comments and zero PR bookkeeping comments. (acceptance 1)
2. Inspect the test issue: zero workflow-added comments; the only GitHub writes are the PR + its `Closes #N`; PR body reads clean and repo-facing; `build.md` is the fuller, *different* summary. (acceptance 2)
3. `semi-auto`: force an agent to raise a genuine ambiguity -> session pauses on inline `AskUserQuestion`; answering (from agent view or session) resumes the same run; artifacts otherwise auto-approve. (acceptance 3)
4. `manual`: each phase stops for inline approve/revise after writing; `revise` re-runs + re-writes in place; `approve` advances; questions still surface as in semi-auto. (acceptance 4)
5. Resumability: set `state.json.pendingQuestion`, kill the session before answering, re-run `/run-pipeline <n>` -> it re-asks that exact question *before anything else*, clears it on answer. (acceptance 5)
6. Isolation: `dependsOn: []` gives agents no access to any other issue's folder; `dependsOn: [143]` grants read-only access to `143/`'s artifacts and nothing else. (acceptance 6)
7. Fleet: dispatch several `/file-pipeline` background sessions -> separate agent-view rows; a question in one shows "Needs input" and is answerable inline without affecting others; the skill contains no multi-issue launcher. (acceptance 7)
8. `merge`: refuses unless `status === human-review`, then squash-merges the linked PR, deletes the branch, sets `status` to `closed`. (acceptance 8)
9. Target repo needs no `status:*` labels created; only `gh` auth (+ optional `type:*` for the skip-spec shortcut). (acceptance 9)
10. Grep the new files: no "openducktor"/"odt" in any file name, directory, agent name, or user-facing string; only lineage comments contain the name. (acceptance 10)
11. Bare `/run-pipeline <n>` (no mode word) runs in semi-auto: surfaces a genuine ambiguity inline but auto-approves artifacts. (acceptance 11)
12. A question is always raised *before* its artifact is written; no written artifact contains an open `[NEEDS CLARIFICATION]` marker; a run stopped mid-question leaves no partial artifact, only `state.json.pendingQuestion`. (acceptance 12)
