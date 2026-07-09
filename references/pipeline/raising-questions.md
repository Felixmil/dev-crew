# Raising a question (the interactive, resumable core)

Shared by every pipeline skill. Whenever a question must be surfaced (an agent returned `clarification-needed`, a manual gate needs an approve/revise decision, or a dependency is missing), do this in exactly this order:

1. **Write `state.json.pendingQuestion` first**, before any prompt: `{"phase": "<phase>"|"dependency"|"gate", "question": "...", "options": [{"label": "...", "description": "..."}, ...], "recommendedDefault": "label of the recommended (first) option"}`. The `<phase>` values are the calling skill's own phase names (its phase-loop table lists them).
2. **Call `AskUserQuestion`** with those options, recommended first. All context the human needs to answer must live inside the question text and the option `label`/`description` fields. Never print decision context as prose before the call. This is a hard rule: text emitted just before an `AskUserQuestion` call can be dropped in a background session, so a self-contained question is the only kind that survives.
3. **If no answer comes back** (the prompt timed out, returned a "no response" / "proceed on best judgment" signal, or otherwise came back empty): do not guess and do not proceed on a default. Stop the run cleanly, leaving `pendingQuestion` set exactly as written in step 1 and `status` unchanged. A later re-run re-asks the exact question (see Resume) and picks up from there. In a background session the prompt may never surface, and a foreground prompt can time out into a "continue on your own judgment" signal; treating either as "no answer, stop" is what keeps a real decision from being silently steamrolled by a default no human ever saw. The only exception is `auto` mode, which by design raises no question in the first place (the agent adopts its own recommended default and records it in the artifact), so there is nothing here to time out.
4. **On the answer: clear `pendingQuestion` to `null`**, then fold the answer into the next action (re-invoke the phase agent with the answer folded into its instructions, take the gate's approve/revise branch, or take the dependency's proceed/wait branch, depending on the persisted `phase`).

Because artifacts are written only after every question is answered, the answer always flows into the agent (or the gate/dependency branch), never into a half-written file. And because the question is persisted before it is asked, a timeout or a non-surfacing background prompt loses nothing: the next run re-asks it.

## Resume a pending question first (before any phase)

Immediately after loading `state.json`, before touching any phase:

- If `state.json.pendingQuestion !== null`, **re-ask that exact question first**. Rebuild the `AskUserQuestion` prompt from the persisted `phase`, `question`, `options`, and `recommendedDefault` (recommended option first). Do not print any context as prose before the call; everything the human needs is inside the question and option text.
- On the answer: **clear `pendingQuestion` to `null`** in `state.json`, then route the answer exactly as if it had just been raised, depending on the persisted `phase`. Then continue the phase loop.

A killed, slept, or closed session therefore loses nothing: the question survives in `state.json`, no artifact was written for it, and this re-ask is the recovery path.
