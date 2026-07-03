---
name: update-branch
description: Brings a branch up to date with its target by merging the target into it, and drives the conflict-resolver only if that merge conflicts, asking you inline only about genuine semantic conflicts the resolver cannot safely settle on its own. Use when a branch is behind its base and needs the base merged in, when a PR shows as BEHIND, or when the user says "update the branch", "merge main into this branch", "bring my branch up to date", "resolve the conflicts", or invokes /update-branch.
---

# Update branch

You bring a branch up to date with its target: **merge the target branch
into it**, and when that merge conflicts, drive the `conflict-resolver`
agent to settle the conflicts, escalating only the genuinely semantic ones
to the user. A clean merge finishes on its own; a conflicted one resolves
the safe hunks automatically and asks you only about the risky ones.

The same principle the rest of this toolkit uses applies: **do the part
that is clearly safe, escalate the genuine judgment calls, never guess.**
A fast-forward or a conflict-free merge needs no one; a semantic conflict
always gets the user's call.

## What you are handed

- Optional **branch name**. A bare `/update-branch` updates the **current**
  branch. `/update-branch <branch>` checks out (or targets) that branch.
- Optional **target**. By default the target is the branch's base (its
  upstream's base, the PR's `baseRefName`, or the repo default branch, in
  that order). `/update-branch <branch> onto <target>` overrides it.
- Optional **issue** for intent: if the branch maps to a pipeline issue,
  its `spec.md`/`plan.md` under `<repo>.issues/<issue>/` help the resolver
  judge conflicts. Passed through to the resolver when available.

## Setup

1. **Identify the branch and its target.** `git rev-parse --show-toplevel`
   for the repo path; the current branch from `git branch --show-current`
   (or the handed branch). Determine the target: an explicit `onto <target>`
   wins; otherwise the tracked base / PR `baseRefName` / repo default
   branch. State which target you resolved and why if it is not obvious.
2. **Fetch and check whether an update is even needed.** `git fetch` the
   target, then `git rev-list --left-right --count <target>...<branch>`. If
   the branch is **not behind** the target (left count zero), tell the user
   it is already up to date and stop, there is nothing to merge.
3. **Confirm a clean working tree.** If the tree is dirty (uncommitted
   changes), stop and tell the user to commit or stash first; do not merge
   over uncommitted work.

## Merge the target in

1. **Run the merge**: `git merge <target>` into the branch (a merge, never
   a rebase, so a shared/reviewed branch keeps its history and any PR review
   threads and comment anchors survive).
2. **If the merge completes cleanly** (fast-forward or auto-merged, no
   conflicts): report what came in (a short `git log` range summary) and
   stop. The branch is now current. Do not push unless the user asks.
3. **If the merge conflicts**: the tree is now in a conflicted merge state.
   Hand it to the conflict-resolver via the loop below.

## The conflict loop you run

You are the thin human-interaction shell around `conflict-resolver`. The
agent does the actual conflict analysis and resolution in the working tree;
it cannot ask you a question (subagents cannot prompt), so it stops and
returns a structured `clarification-needed` result whenever a conflict is
genuinely semantic. **Your job is to turn that into an `AskUserQuestion`,
take the answer, and re-invoke the agent with your decision, until it
reports everything resolved.**

The agent auto-resolves only conflicts it can prove are safe (both sides
equivalent, one a pure superset, disjoint additions, formatting/import
order). It never guesses on a real semantic conflict; those come back to
you.

1. **Invoke the agent** (`conflict-resolver`) with a `schema` forcing its
   structured return, handing it the repo path, the operation (a merge of
   `<target>` into `<branch>`) and the target branch, and any issue intent
   paths. On the first call, no decision; on later calls, include the
   decision the user just made and which file/conflict it applies to.

2. **Read the agent's returned object:**
   - `{"status":"done", ...}` -> the tree is resolved, staged, and verified
     (build/tests pass over the merged result). The merge is ready to
     commit. Complete the merge (`git commit --no-edit` to finalize the
     merge commit) so the branch is actually up to date, then report the
     summary. Do not push unless the user asks.
   - `{"status":"clarification-needed", question, options, recommendedDefault, file}`
     -> a semantic conflict needs the user (step 3).

3. **Surface the conflict with `AskUserQuestion`.** Build the call directly
   from the returned `question` and `options`, recommended option first.
   **Do not print the conflict as prose before the call;** everything the
   user needs (the file, what each side does, the recommended resolution)
   is inside the returned question and option text. Keep the options as the
   agent framed them (typically: take side A, take side B, or combine).

4. **Re-invoke the agent** with the user's chosen resolution folded into
   its inputs (the decision plus the `file` it applies to), so it applies
   exactly that resolution to exactly that conflict and moves on.

5. **Go back to step 2.** Repeat until the agent returns `done`. The agent
   may escalate several conflicts across several round-trips; each is
   answered before it proceeds.

## If a question goes unanswered

If `AskUserQuestion` returns no usable answer (timed out, empty, declined),
**do not guess and do not tell the agent to pick a side.** Stop. Leave the
working tree exactly as the agent left it (safe hunks resolved and staged,
the escalated semantic hunk still marked and unstaged), and tell the user
which conflict is still open so they can re-run `/update-branch` and answer
it. A half-resolved tree with the hard conflict still clearly marked is a
safe place to stop; a guessed merge is not. Do **not** leave the paused
merge unexplained; say the merge is stopped mid-conflict.

## Anti-patterns

- Rebasing instead of merging. This skill merges the target in on purpose,
  so shared/reviewed branches keep their history and comment anchors.
- Merging over a dirty tree, or when the branch is not actually behind.
  Check first; if there is nothing to do, say so and stop.
- Guessing a resolution, or telling the agent to pick a side, when a
  question went unanswered. Stop instead.
- Printing the conflict as prose before `AskUserQuestion`. Put it all
  inside the question and option text (the agent already framed it there).
- Resolving conflicts yourself with your own `Edit`/`git add`. The agent
  owns the working tree; you only ask and relay decisions.
- Pushing on the user's behalf. Finalize the merge commit so the branch is
  current, but leave pushing to the user unless they asked.

## Done criteria

The branch was already current (nothing to do, reported), or the target
was merged in: cleanly (reported what came in), or with conflicts driven to
`done` by the agent (tree has zero conflict markers, every previously
conflicted file staged, build and relevant tests passing over the merged
result) with the merge commit finalized so the branch is genuinely up to
date, and every semantic conflict decided by the user via `AskUserQuestion`
(never guessed). Pushing was left to the user unless they asked. Or the run
stopped cleanly on an unanswered question, with the safe hunks staged, the
hard conflict still marked, and the paused merge state reported for a
re-run.
