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
run the openducktor-issue workflow on issue 142
```

### Agent type names are plugin-prefixed

Once installed via a plugin, the four agents are not registered as `spec-agent`, `planner-agent`, `build-agent`, `qa-agent`. They're namespaced as `openducktor-agents:spec-agent`, `openducktor-agents:planner-agent`, `openducktor-agents:build-agent`, `openducktor-agents:qa-agent`, to avoid colliding with same-named agents from other plugins or from a project's own `.claude/agents/`. `workflows/openducktor-issue.js` already uses the prefixed names. If you write your own workflow or call these agents directly, use the prefixed form; the bare name will fail with an "agent type not found" error listing the actual registered names.

## The state machine

`scripts/odt-transition.sh` enforces the same transition table as OpenDucktor's `status-transition-policy.ts`:

```
status:open -> status:spec-ready -> status:ready-for-dev -> status:in-progress
  -> status:ai-review -> status:human-review -> status:closed
```

Task and bug issues (label `type:task` or `type:bug`) may skip straight from `status:open` to `status:in-progress`.

No agent in `agents/` is given `gh issue edit --add-label`. Only `odt-transition.sh` writes labels, and it refuses any transition not in the table above. This is deliberate: the model that can be talked into anything should never hold the pen that moves the state machine.

## Target repo prerequisites

- `gh` CLI authenticated against the repo.
- Labels created: `status:open`, `status:spec-ready`, `status:ready-for-dev`, `status:in-progress`, `status:blocked`, `status:ai-review`, `status:human-review`, `status:closed`, plus `type:task` / `type:bug` / `type:feature` / `type:epic` if you want the skip-spec shortcut to apply.

## Known gaps versus OpenDucktor

- No worktree isolation between build and QA by default. Pass `isolation: "worktree"` to the build-agent call in the workflow script if agents run concurrently and might collide.
- The QA verdict is a `QA-VERDICT: approved|rejected` string convention read out of the agent's final text, not a typed tool call. Passing a `schema` to that `agent()` call would remove the string-matching risk.
- No cross-task or cross-issue coherence check. Each issue is planned and built independently; nothing here detects two issues whose specs contradict each other. Neither does OpenDucktor's own state machine, beyond blocking an epic from closing while a subtask is still open.
- No canonical task-summary object. Every agent re-reads the full issue thread via `gh issue view --comments` instead of a cached document-presence summary.
