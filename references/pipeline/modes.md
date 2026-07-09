# Modes: two orthogonal axes

Shared by every pipeline skill. The mode word is one of `auto`, `semi-auto`, or `manual`. Evaluate these two decisions separately for every phase.

- **Questions axis** (is an agent's raised ambiguity surfaced?):
  - `auto`: never. Invoke the agent told to adopt its own recommended default and record the decision in the artifact, so it returns `done`. Nothing is written to `pendingQuestion`; nothing prompts.
  - `semi-auto` / `manual`: a `clarification-needed` return is surfaced inline via the "Raising a question" procedure.
- **Artifact-approval axis** (do you stop after a written/delivered artifact?):
  - `auto` / `semi-auto`: auto-approve every artifact; advance immediately.
  - `manual`: after each phase's artifact is written and read back, use `AskUserQuestion` to approve or revise. `approve` advances via the transition script (into that phase's `*-awaiting-approval` gate then out to the real next status, matching the gate edges). `revise` re-runs that phase's agent with the feedback, re-writes the artifact in place, and asks again. The QA-gate `revise` routes the feedback plus the current `qa.md` to the **build** agent (not QA), re-runs QA, re-writes `qa.md`, and stays at the gate.

The axes are genuinely orthogonal: a phase artifact with no question in `semi-auto` still auto-approves; the same artifact in `manual` still stops for approval even though no question was raised.
