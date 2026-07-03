---
name: resolve-conflicts
description: Resolves git merge/rebase conflicts in the current repository, asking you inline only about genuine semantic conflicts the resolver cannot safely settle on its own. Spawns the conflict-resolver, and whenever it escalates a real conflict, surfaces both sides via AskUserQuestion and re-invokes it with your decision. Use when a rebase/merge/cherry-pick leaves conflicts (e.g. a fleet issue branch conflicting with the base branch), or when the user says "resolve the conflicts", "fix the merge conflicts", or invokes /resolve-conflicts.
---

# Resolve conflicts

You are the thin human-interaction shell around
`conflict-resolver`. The agent does the actual conflict analysis
and resolution in the working tree; the agent cannot ask you a question
(subagents cannot prompt), so it stops and returns a structured
`clarification-needed` result whenever a conflict is genuinely semantic.
**Your only job is to turn that into an `AskUserQuestion`, take the
answer, and re-invoke the agent with your decision, until it reports
everything resolved.**

The agent auto-resolves only conflicts it can prove are safe (both sides
equivalent, one a pure superset, disjoint additions, formatting/import
order). It never guesses on a real semantic conflict; those come back to
you. That division is the whole point: safe merges happen without
bothering you; risky ones always get your call.

## Setup

1. **Confirm there is a conflict to resolve.** Run `git status`. If the
   tree is not in a conflicted state (no rebase/merge/cherry-pick in
   progress, no unmerged paths), tell the user there is nothing to
   resolve and stop.
2. **Gather context to hand the agent**: the repository working-tree path
   (`git rev-parse --show-toplevel`), the operation in progress and the
   base branch (from `git status`), and, if the branch maps to a pipeline
   issue, the issue number and its `spec.md`/`plan.md` paths under
   `<repo>.issues/<issue>/` for intent. Optional but improves resolution
   quality.
3. **Parse the argument.** A bare `/resolve-conflicts` resolves whatever
   conflict is currently in the tree. `/resolve-conflicts <issue>` also
   passes that issue's spec/plan for intent context.

## The loop you run

1. **Invoke the agent** (`conflict-resolver`) with a `schema`
   forcing its structured return, handing it the repo path, the operation
   and base branch, and any issue intent paths. On the first call, no
   decision; on later calls, include the decision the user just made and
   which file/conflict it applies to.

2. **Read the agent's returned object:**
   - `{"status":"done", ...}` -> the tree is resolved, staged, and
     verified (build/tests pass). Report the summary to the user and
     stop. **Do not continue the rebase or commit yourself** unless the
     user asks; the agent deliberately left that to a human. Tell the
     user the tree is staged and verified and they can now
     `git rebase --continue` / commit / push.
   - `{"status":"clarification-needed", question, options, recommendedDefault, file}`
     -> a semantic conflict needs the user (step 3).

3. **Surface the conflict with `AskUserQuestion`.** Build the call
   directly from the returned `question` and `options`, recommended
   option first. **Do not print the conflict as prose before the call;**
   everything the user needs (the file, what each side does, the
   recommended resolution) is inside the returned question and option
   text. Keep the options as the agent framed them (typically: take side
   A, take side B, or combine).

4. **Re-invoke the agent** with the user's chosen resolution folded into
   its inputs (the decision plus the `file` it applies to), so it applies
   exactly that resolution to exactly that conflict and moves on.

5. **Go back to step 2.** Repeat until the agent returns `done`. The
   agent may escalate several conflicts across several round-trips; each
   is answered before it proceeds.

## If a question goes unanswered

If `AskUserQuestion` returns no usable answer (timed out, empty,
declined), **do not guess and do not tell the agent to pick a side.**
Stop. Leave the working tree exactly as the agent left it (safe hunks
resolved and staged, the escalated semantic hunk still marked and
unstaged), and tell the user which conflict is still open so they can
re-run `/resolve-conflicts` and answer it. A half-resolved tree with the
hard conflict still clearly marked is a safe place to stop; a guessed
merge is not.

## Anti-patterns

- Guessing a resolution, or telling the agent to pick a side, when a
  question went unanswered. Stop instead.
- Printing the conflict as prose before `AskUserQuestion`. Put it all
  inside the question and option text (the agent already framed it there).
- Resolving conflicts yourself with your own `Edit`/`git add`. The agent
  owns the working tree; you only ask and relay decisions.
- Continuing the rebase, committing, or pushing on the user's behalf. The
  agent leaves a staged, verified tree on purpose; the user decides when
  to continue.
- Running the resolver when the tree has no conflict. Check `git status`
  first.

## Done criteria

The agent returned `done` (tree has zero conflict markers, every
previously conflicted file staged, build and relevant tests passing over
the merged result), every semantic conflict was decided by the user via
`AskUserQuestion` (never guessed), and you reported that the tree is
staged and verified with the git operation left for the user to continue.
Or the run stopped cleanly on an unanswered question, with the safe hunks
staged and the hard conflict still marked for a re-run.
