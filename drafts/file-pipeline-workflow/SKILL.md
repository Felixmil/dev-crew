---
name: file-pipeline-workflow
description: "DRAFT / INACTIVE (kept under drafts/, not discovered, do not invoke). The dynamic-workflow variant of the file-based pipeline; the in-session file-pipeline skill was kept instead. See drafts/README.md."
---

<!--
DRAFT / INACTIVE. This skill lives under drafts/, outside the plugin's
discovered skills/ directory, so it is not registered and cannot be
invoked. The in-session `file-pipeline` skill was chosen as the variant
to keep; this workflow-driven shell was deactivated (not deleted). The
engine it drove is drafts/file-pipeline.js. See drafts/README.md for the
reactivation steps. The original content is preserved below unchanged for
that purpose.
-->

# File pipeline (workflow-driven)

You are the thin human-interaction shell around `workflows/file-pipeline.js`.
The workflow is the engine: it owns the phase loop, the four
file-writing agents, the `state.json` state machine, and every
bookkeeping call. It keeps all state and all four artifacts on the local
filesystem under `<repo>.issues/<issue>/`, posts nothing to the issue
thread, and produces a pull request as the only ship channel, exactly
like the in-session `file-pipeline` skill.

The one thing the workflow structurally cannot do is ask you a question:
its `agent()` calls are subagents, and the workflow runtime has no prompt
primitive. So the workflow never guesses. When it needs a human decision
it persists the question to `state.json.pendingQuestion` and **returns**
a small typed object describing what it is waiting on. **Your only job is
to turn that returned object into an `AskUserQuestion`, take the answer,
and relaunch the workflow with the answer folded into its args.** From
the user's seat this is one continuous ask/answer/continue; under the
hood it is stop-and-resume across the answer, and the resume replays every
completed phase from cache so no prior work is redone.

## When to use this vs the in-session file-pipeline skill

Both keep state and artifacts on the filesystem and behave identically to
the user. They differ only in the engine:

- **This skill (`file-pipeline-workflow`)** runs the pipeline as a real
  dynamic Workflow. The phase work, fan-out, and bookkeeping run inside
  the workflow runtime; you only broker questions. Prefer it when you
  want the workflow engine (its progress view, its cached resume, running
  it headless later with answers passed as args).
- **The `file-pipeline` skill** runs the whole loop in this session's own
  context and asks questions inline with true same-run continuation (no
  relaunch). Prefer it when you want the simplest interactive run.

Pick one per issue; do not drive the same issue with both (they share the
same `state.json`, so it is safe, but redundant).

## The loop you run

1. **Parse the argument** as `<issue> [mode]`. `mode` is one of `auto`,
   `semi-auto`, `manual`, or the terminal action `merge`. If no mode word
   is given, pass none and let the workflow default (a persisted mode wins
   on a resume; a fresh issue defaults to `semi-auto`). Reject any other
   mode word loudly.

2. **Launch the workflow.** Call `Workflow` with the script and an object
   `args`, including `launch: 1`:

   ```
   Workflow({
     scriptPath: ".claude/workflows/file-pipeline.js",
     args: { issueNumber: <issue>, mode: <mode-if-given>, launch: 1 },
   })
   ```

   Keep the returned **`runId`** (from the tool result). You need it to
   resume. Also keep a **launch counter** starting at `1`; you will
   increment it on every relaunch (step 6).

   **Why the launch counter matters (do not skip it).** A resume via
   `resumeFromRunId` replays every workflow step whose inputs are
   unchanged. The workflow's reads of its own on-disk `state.json` would
   otherwise replay a *stale, pre-answer* snapshot on resume, so the
   workflow would never see the answer you just gave and would loop
   forever re-asking the same question. Passing a fresh, higher `launch`
   on each relaunch is what forces those state reads to run live and see
   the current file. If you relaunch with a stale or missing `launch`, the
   resume silently does nothing.

3. **Read the workflow's returned object.** Its `status` field tells you
   what happened:

   | `status` | Meaning | What you do |
   | --- | --- | --- |
   | `question` | An agent raised a clarification. | Ask it (step 4), relaunch with `answer`. |
   | `gate` | A manual-mode phase wrote its artifact and is awaiting approve/revise. | Ask it (step 4), relaunch with `directive`. |
   | `dependency` | A depended-on issue has no artifacts yet. | Ask it (step 4), relaunch with `directive`. |
   | `done` | Nothing left to drive; the issue reached its resting point. | Stop; report the final `state`. |
   | `rejected` | QA still rejected after the round cap; left at `in-progress`. | Stop; report it for a human. |
   | `merged` | Merge action completed. | Stop; report the merged PR. |
   | `waiting` | The human chose to wait (e.g. on a dependency). | Stop; report it. |

   For any terminal status (`done`, `rejected`, `merged`, `waiting`),
   summarize the outcome to the user and finish. Do not relaunch.

4. **Surface the decision with `AskUserQuestion`.** The returned object
   carries `pendingQuestion` with `{question, options, recommendedDefault}`
   (and `phase`/`kind`). Build the `AskUserQuestion` call directly from
   those fields, recommended option first. **Do not print any decision
   context as prose before the call; everything the user needs is inside
   the returned `question` and option text.** (The workflow already
   persisted the question to `state.json.pendingQuestion` before
   returning, so a killed session loses nothing: a re-run relaunches the
   workflow, which re-returns the same pending question, and you re-ask it.)

5. **Map the answer to a relaunch arg**, by the returned `kind`:
   - `kind: "clarification"` -> `args.answer` = the chosen option's label
     (plus any free-text the user added).
   - `kind: "gate"` -> `args.directive`:
     - user approved -> `{ kind: "approve" }`
     - user chose revise -> `{ kind: "revise", feedback: "<their feedback>" }`
   - `kind: "dependency"` -> `args.directive`:
     - proceed -> `{ kind: "proceed" }`
     - wait -> `{ kind: "wait" }`

6. **Relaunch the workflow, resuming from the same run** so completed
   phases replay from cache and only the answer-consuming call onward runs
   live. **Increment the launch counter and pass it** (this is what makes
   the resume see your answer, per step 2):

   ```
   Workflow({
     scriptPath: ".claude/workflows/file-pipeline.js",
     resumeFromRunId: "<runId from the previous call>",
     args: { issueNumber: <issue>, answer: "...", launch: <previous launch + 1> },
     // or, at a gate/dependency: directive: {...} instead of answer
   })
   ```

   Keep the new `runId` it returns and the incremented launch counter; use
   them for the next resume. Every relaunch uses a strictly higher
   `launch` than the one before it.

7. **Go back to step 3** with the newly returned object. Repeat until a
   terminal status.

## If a question goes unanswered

If `AskUserQuestion` returns no usable answer (it timed out, came back
empty, or the user declined), **do not guess and do not relaunch with a
made-up answer.** Stop. The workflow already left `pendingQuestion` set in
`state.json` and did not advance the status, so a later re-run recovers.

Note the two recovery paths differ in one detail:

- **Same session, later:** relaunch with `resumeFromRunId` and the next
  `launch` value, exactly as in step 6.
- **Fresh session (after a kill/close):** a brand-new
  `/file-pipeline-workflow <issue>` invocation starts at `launch: 1` with
  **no** `resumeFromRunId`. That is a fresh run with no prior cache, so it
  genuinely re-reads `state.json`, sees the persisted `pendingQuestion`,
  and re-asks. This is the most robust recovery and needs no special
  handling. Report to the user that the run is paused awaiting the
  decision.

## Merge

`/file-pipeline-workflow <issue> merge` launches the workflow with
`mode: "merge"`. That is a standalone terminal action: the workflow
refuses unless `state.json.status` is `human-review`, then squash-merges
the linked PR and closes the issue. It returns `status: "merged"` (or
throws with a clear message). Relaunch is never needed for merge; report
the result and finish.

## Anti-patterns

- Guessing an answer, or relaunching with a default the user never chose,
  when a question went unanswered. Stop instead; the persisted
  `pendingQuestion` makes a re-run re-ask it.
- Printing decision context as prose before `AskUserQuestion`. Put all of
  it inside the question and option text (the workflow already put it in
  the returned object).
- Doing any pipeline work yourself, reading or writing `state.json`,
  running the transition script, calling the phase agents, or touching the
  artifacts. The workflow owns all of that. You only launch it, ask, and
  relaunch.
- Relaunching, within the same session, without `resumeFromRunId`. That
  re-executes every phase from scratch instead of replaying from cache.
  (A brand-new invocation in a fresh session correctly has no
  `resumeFromRunId`; that is the fresh-recovery path above, not this
  anti-pattern.)
- Relaunching with a stale or missing `launch` value. The resume then
  replays the pre-answer state snapshot, never sees the answer, and loops
  re-asking the same question. Always pass a strictly higher `launch` than
  the previous call.
- Driving the same issue with both this skill and the in-session
  `file-pipeline` skill in a way that interleaves. Pick one engine.

## Done criteria

The workflow reached a terminal status (`done`, `rejected`, `merged`, or
`waiting`), every question it raised was surfaced to the user via
`AskUserQuestion` and answered (or the run is cleanly paused on an
unanswered one, with `pendingQuestion` still set for a re-run), and you
reported the outcome. You never wrote `state.json`, ran the transition
script, or invoked a phase agent yourself.
