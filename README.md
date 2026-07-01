# openducktor-agents

Spec, planner, build, and QA subagents modeled on [OpenDucktor](https://github.com/Maxsky5/openducktor)'s agent workflow, adapted to run as Claude Code subagents against a GitHub issue's labels instead of OpenDucktor's own task store.

## What's here

```
agents/                  four Claude Code subagent definitions (plugin-installable)
  spec-agent.md
  planner-agent.md
  build-agent.md
  qa-agent.md
workflows/
  openducktor-issue.js   drives one issue through spec -> plan -> build -> qa
scripts/
  odt-transition.sh      the only thing allowed to write an issue's status:* label
```

## Two different installation paths

Claude Code plugins can auto-discover an `agents/` directory, but there is no plugin mechanism for Workflow scripts today. That means this repo installs in two different ways depending on the piece:

### The four agents: install once as a plugin

```
/plugin marketplace add ~/Code/openducktor-agents
/plugin install openducktor-agents@openducktor-agents
```

After that, `spec-agent`, `planner-agent`, `build-agent`, and `qa-agent` are available as `subagent_type` in every project, no per-repo copying.

### The workflow and transition script: copy per repo

Copy both files into the repo you want to run this against:

```
cp workflows/openducktor-issue.js  <target-repo>/.claude/workflows/
cp scripts/odt-transition.sh       <target-repo>/scripts/
chmod +x <target-repo>/scripts/odt-transition.sh
```

Then in that repo, invoke it explicitly:

```
run the openducktor-issue workflow on issue 142 in auto mode
run the openducktor-issue workflow on issue 142 in manual mode
```

or programmatically: `Workflow({ scriptPath: ".claude/workflows/openducktor-issue.js", args: { issueNumber: 142, mode: "auto" } })`. The `/openducktor-issue 142` slash-command form always runs in auto mode, since a slash command only passes a bare string as `args`.

### Auto mode versus manual mode

**Auto mode** runs straight through: each phase's agent posts its artifact, the transition script immediately advances the label, and the next phase starts in the same invocation, ending at a QA verdict.

**Manual mode** stops after every phase. The phase's artifact comment is posted, tagged with a hidden `<!-- odt:<phase> -->` marker, and the issue is set to a `status:<phase>-awaiting-approval` gate label. The run ends there. A human reviews the artifact on the issue and comments:

- `/approve`, to advance past the gate. Re-running the workflow (same issue, same or no mode argument) picks this up, performs the real transition, and continues into the next phase, which stops at its own gate in turn.
- `/revise <feedback>`, to send that feedback back into the same phase's agent. The agent edits the existing tagged comment in place (it does not post a second copy) and replies summarizing what changed. The issue stays at the same gate, awaiting another `/approve` or `/revise`.

Re-running the workflow with no `/approve` or `/revise` comment since the gate was set is always safe: it reports "waiting for review" and exits without touching anything.

Every posted or revised comment mentions `@Felixmil` (configurable via `NOTIFY_GITHUB_USERNAME` at the top of the script) so GitHub sends a notification regardless of the repo's default notification settings.

### QA rejection loops back into build

A `QA-VERDICT: rejected` report is fed back to the build agent as fix-it feedback, not left for a human to relay by hand:

- **Auto mode**: rejection re-invokes the build agent with the QA report, then re-runs QA, up to `MAX_QA_ROUNDS` (default 3) total build attempts in the same run. Still rejected after the cap, the issue is left at `status:in-progress` for a human.
- **Manual mode**: at the `status:qa-awaiting-approval` gate, `/revise <feedback>` sends the QA report plus that feedback to the build agent (not back to the QA agent), then automatically re-runs QA and re-posts at the same gate. `/approve` at that gate still reads whichever verdict is currently posted and transitions accordingly.

### Agent type names are plugin-prefixed

Once installed via a plugin, the four agents are not registered as `spec-agent`, `planner-agent`, `build-agent`, `qa-agent`. They're namespaced as `openducktor-agents:spec-agent`, `openducktor-agents:planner-agent`, `openducktor-agents:build-agent`, `openducktor-agents:qa-agent`, to avoid colliding with same-named agents from other plugins or from a project's own `.claude/agents/`. `workflows/openducktor-issue.js` already uses the prefixed names. If you write your own workflow or call these agents directly, use the prefixed form; the bare name will fail with an "agent type not found" error listing the actual registered names.

## The state machine

`scripts/odt-transition.sh` enforces the same transition table as OpenDucktor's `status-transition-policy.ts`:

```
status:open -> status:spec-ready -> status:ready-for-dev -> status:in-progress
  -> status:ai-review -> status:human-review -> status:closed
```

Task and bug issues (label `type:task` or `type:bug`) may skip straight from `status:open` to `status:in-progress`.

No agent in `agents/` is given `gh issue edit --add-label`. Only `odt-transition.sh` writes label *transitions*, and it refuses any transition not in the table above. This is deliberate: the model that can be talked into anything should never hold the pen that moves the state machine.

The one exception is bootstrapping: a freshly filed issue has no `status:*` label at all, which is not a transition (there is no "from" state), so `workflows/openducktor-issue.js` seeds `status:open` directly via `gh issue edit --add-label` the first time it sees such an issue, then proceeds normally through `odt-transition.sh` from there.

Manual mode adds four gate labels to the same table, one per phase: `status:spec-awaiting-approval`, `status:plan-awaiting-approval`, `status:build-awaiting-approval`, `status:qa-awaiting-approval`. Each is entered from the status that precedes its phase and exits, on `/approve`, to the exact real status that phase would have produced in auto mode. Auto mode never touches these labels.

## Target repo prerequisites

- `gh` CLI authenticated against the repo.
- Labels created: `status:open`, `status:spec-ready`, `status:ready-for-dev`, `status:in-progress`, `status:blocked`, `status:ai-review`, `status:human-review`, `status:closed`, plus `type:task` / `type:bug` / `type:feature` / `type:epic` if you want the skip-spec shortcut to apply.
- For manual mode: also create `status:spec-awaiting-approval`, `status:plan-awaiting-approval`, `status:build-awaiting-approval`, `status:qa-awaiting-approval`.

## Known gaps versus OpenDucktor

- No worktree isolation between build and QA by default. Pass `isolation: "worktree"` to the build-agent call in the workflow script if agents run concurrently and might collide.
- The QA verdict is a `QA-VERDICT: approved|rejected` string convention read out of the agent's final text, not a typed tool call. Passing a `schema` to that `agent()` call would remove the string-matching risk.
- No cross-task or cross-issue coherence check. Each issue is planned and built independently; nothing here detects two issues whose specs contradict each other. Neither does OpenDucktor's own state machine, beyond blocking an epic from closing while a subtask is still open.
- No canonical task-summary object. Every agent re-reads the full issue thread via `gh issue view --comments` instead of a cached document-presence summary.
- The QA report and build completion summary live on the issue thread rather than the pull request they actually describe. Spec and plan have to live on the issue (no PR exists yet at that point), but build/QA arguably belong on the PR's own review thread. Not yet changed, since it would also mean scoping `/approve` and `/revise` detection to two different comment streams instead of one.
