// Copy this file into a target repo's .claude/workflows/ directory
// (plugins cannot distribute Workflow scripts today; only agents/
// are plugin-discoverable). Requires scripts/odt-transition.sh to
// also be copied into that repo's scripts/ directory, and the four
// agents from this plugin to be installed.
//
// Run with:
//   Workflow({ scriptPath: ".claude/workflows/openducktor-issue.js", args: { issueNumber: 142, mode: "auto" } })
//   Workflow({ scriptPath: ".claude/workflows/openducktor-issue.js", args: { issueNumber: 142, mode: "manual" } })
// or as a slash command: /openducktor-issue 142 (bare string args always run in auto mode)
//
// auto mode: identical to the original script. Every phase's output
// is immediately approved and the pipeline runs straight through to
// a QA verdict in one invocation.
//
// manual mode: each phase stops at a status:<phase>-awaiting-approval
// gate after posting its artifact as a tagged issue comment, and the
// run ends. A human reviews the artifact on the issue and comments
// either:
//   /approve                 -> advance to the next real status and
//                               continue into the next phase (which
//                               will stop at its own gate in turn)
//   /revise <feedback text>  -> re-run the same phase's agent with
//                               that feedback, editing the existing
//                               tagged comment in place and replying
//                               to the /revise comment, then stay at
//                               the same gate
// Re-running this script with the same issue number and mode: manual
// is always safe. If no /approve or /revise comment has been posted
// since the gate was set, it reports "waiting" and exits without
// doing anything.

export const meta = {
  name: "openducktor-issue",
  description:
    "Drive one GitHub issue through spec -> plan -> build -> qa, auto or gated on human approval",
  phases: [{ title: "Spec" }, { title: "Plan" }, { title: "Build" }, { title: "QA" }],
};

// GitHub notifies the issue author on any comment automatically, but
// an explicit @-mention is the reliable trigger regardless of that
// setting. Set this to the GitHub username who should be pinged when
// an artifact is posted or revised. Leave "" to disable mentioning.
const NOTIFY_GITHUB_USERNAME = "Felixmil";

const mentionSuffix = () =>
  NOTIFY_GITHUB_USERNAME ? ` Mention @${NOTIFY_GITHUB_USERNAME} in the comment so they are notified.` : "";

const PHASE_DEFS = [
  {
    key: "spec",
    label: "Spec",
    tag: "<!-- odt:spec -->",
    fromStatus: "status:open",
    gateLabel: "status:spec-awaiting-approval",
    toStatus: "status:spec-ready",
    agentType: "openducktor-agents:spec-agent",
    kickoff: (issue) => `Read GitHub issue ${issue} and write its specification.`,
    revisePrompt: (issue, feedback) =>
      `Read GitHub issue ${issue}. A human requested changes to the posted spec: "${feedback}". ` +
      `Edit the existing spec comment in place with the revised markdown (do not post a second spec comment), ` +
      `then post a short reply comment summarizing what changed.`,
  },
  {
    key: "plan",
    label: "Plan",
    tag: "<!-- odt:plan -->",
    fromStatus: "status:spec-ready",
    gateLabel: "status:plan-awaiting-approval",
    toStatus: "status:ready-for-dev",
    agentType: "openducktor-agents:planner-agent",
    kickoff: (issue) => `Read GitHub issue ${issue}'s spec and write its implementation plan.`,
    revisePrompt: (issue, feedback) =>
      `Read GitHub issue ${issue}. A human requested changes to the posted plan: "${feedback}". ` +
      `Edit the existing plan comment in place with the revised markdown (do not post a second plan comment), ` +
      `then post a short reply comment summarizing what changed.`,
  },
  {
    key: "build",
    label: "Build",
    tag: "<!-- odt:build -->",
    fromStatus: "status:ready-for-dev",
    gateLabel: "status:build-awaiting-approval",
    toStatus: "status:ai-review",
    agentType: "openducktor-agents:build-agent",
    kickoff: (issue) => `Implement GitHub issue ${issue} per its spec and plan.`,
    revisePrompt: (issue, feedback) =>
      `Read GitHub issue ${issue}. A human requested changes to the implementation: "${feedback}". ` +
      `Make the requested changes, update the existing completion-summary comment in place ` +
      `(do not post a second completion-summary comment), then post a short reply comment ` +
      `summarizing what changed.`,
  },
  {
    key: "qa",
    label: "QA",
    tag: "<!-- odt:qa -->",
    fromStatus: "status:ai-review",
    gateLabel: "status:qa-awaiting-approval",
    // No single toStatus: the QA verdict decides human-review vs in-progress.
    agentType: "openducktor-agents:qa-agent",
    kickoff: (issue) =>
      `Review the pull request for GitHub issue ${issue} against its spec and plan. ` +
      `End your report with exactly one line, either "QA-VERDICT: approved" or "QA-VERDICT: rejected".`,
    revisePrompt: (issue, feedback) =>
      `Read GitHub issue ${issue}. A human requested another look at the QA report: "${feedback}". ` +
      `Re-review, edit the existing QA report comment in place (do not post a second QA report comment), ` +
      `end it with exactly one "QA-VERDICT: approved" or "QA-VERDICT: rejected" line, ` +
      `then post a short reply comment summarizing what changed.`,
  },
];

async function transitionTo(issue, to) {
  await agent(`Run: bash scripts/odt-transition.sh ${issue} ${to}`, { label: "transition" });
}

async function currentLabel(issue) {
  return await agent(
    `Run: gh issue view ${issue} --json labels --jq '.labels[].name | select(startswith("status:"))'. Return only that label string.`,
    { label: "read-label" },
  );
}

// Every comment on the issue that comes after the one tagged with
// `tag`, oldest first, as an array of { body } objects. [] if the
// tagged comment does not exist yet.
async function commentsSinceTag(issue, tag) {
  const jq =
    `.comments as $c | ($c | to_entries | map(select(.value.body | contains("${tag}"))) | ` +
    `if length == 0 then -1 else .[-1].key end) as $i | ` +
    `[$c[($i + 1):][] | {body: .body}]`;
  const result = await agent(`Run exactly: gh issue view ${issue} --json comments --jq '${jq}'. Return only its raw stdout.`, {
    label: "read-comments-since-tag",
  });
  try {
    return JSON.parse(result);
  } catch {
    return [];
  }
}

function latestDirective(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = (comments[i].body ?? "").trim();
    if (body.startsWith("/approve")) {
      return { kind: "approve" };
    }
    if (body.startsWith("/revise")) {
      return { kind: "revise", feedback: body.slice("/revise".length).trim() };
    }
  }
  return null;
}

async function postArtifact(issue, def) {
  await agent(
    `${def.kickoff(issue)} Tag the posted comment's body with the literal text ${def.tag} on its own line.${mentionSuffix()}`,
    { agentType: def.agentType, phase: def.label },
  );
}

async function postQaArtifact(issue, def) {
  const report = await agent(
    `${def.kickoff(issue)} Tag the posted comment's body with the literal text ${def.tag} on its own line.${mentionSuffix()}`,
    { agentType: def.agentType, phase: def.label },
  );
  return report.includes("QA-VERDICT: approved") ? "approved" : "rejected";
}

async function revise(issue, def, feedback) {
  const prompt = `${def.revisePrompt(issue, feedback)}${mentionSuffix()}`;
  if (def.key === "qa") {
    const report = await agent(prompt, { agentType: def.agentType, phase: "Revise" });
    return report.includes("QA-VERDICT: approved") ? "approved" : "rejected";
  }
  await agent(prompt, { agentType: def.agentType, phase: "Revise" });
  return null;
}

const issueArg = typeof args === "object" && args !== null ? args.issueNumber : args;
const mode = (typeof args === "object" && args !== null ? args.mode : undefined) ?? "auto";
if (!issueArg) {
  throw new Error(
    'Missing issue number. Pass args: { issueNumber: N, mode: "auto" | "manual" } or invoke as "/openducktor-issue N" (auto mode).',
  );
}
if (mode !== "auto" && mode !== "manual") {
  throw new Error(`Unknown mode "${mode}". Use "auto" or "manual".`);
}
const issue = issueArg;

let label = await currentLabel(issue);

// Resolve a pending gate first. A gate can only exist because a
// prior manual-mode run stopped there, so this applies regardless
// of the mode this run was invoked with.
const gateDef = PHASE_DEFS.find((def) => def.gateLabel === label);
if (gateDef) {
  const comments = await commentsSinceTag(issue, gateDef.tag);
  const directive = latestDirective(comments);

  if (!directive) {
    log(`Issue ${issue} is waiting for review at ${label}. Comment /approve or /revise <feedback> to continue.`);
    return { issue, status: "waiting", gate: label };
  }

  if (directive.kind === "revise") {
    phase("Revise");
    const verdict = await revise(issue, gateDef, directive.feedback);
    if (gateDef.key === "qa" && verdict) {
      log(`Issue ${issue} QA revised (${verdict}), still awaiting /approve at ${label}.`);
      return { issue, status: "revised", gate: label, verdict };
    }
    log(`Issue ${issue} ${gateDef.key} revised, still awaiting /approve at ${label}.`);
    return { issue, status: "revised", gate: label };
  }

  // directive.kind === "approve"
  if (gateDef.key === "qa") {
    const postGateComments = await commentsSinceTag(issue, gateDef.tag);
    const verdictComment = [...postGateComments].reverse().find((c) => (c.body ?? "").includes("QA-VERDICT:"));
    const approved = (verdictComment?.body ?? "").includes("QA-VERDICT: approved");
    await transitionTo(issue, approved ? "status:human-review" : "status:in-progress");
  } else {
    await transitionTo(issue, gateDef.toStatus);
  }
  label = await currentLabel(issue);
}

// Walk the remaining phases in order from whichever real status we
// are now at.
for (const def of PHASE_DEFS) {
  if (label !== def.fromStatus) {
    continue;
  }

  phase(def.label);

  if (def.key === "qa") {
    const verdict = await postQaArtifact(issue, def);
    if (mode === "manual") {
      await transitionTo(issue, def.gateLabel);
      log(`Issue ${issue} QA report posted (${verdict}), awaiting /approve at ${def.gateLabel}.`);
      return { issue, status: "awaiting_approval", gate: def.gateLabel, verdict };
    }
    await transitionTo(issue, verdict === "approved" ? "status:human-review" : "status:in-progress");
    log(`Issue ${issue} QA ${verdict}.`);
    label = await currentLabel(issue);
    continue;
  }

  await postArtifact(issue, def);

  if (mode === "manual") {
    await transitionTo(issue, def.gateLabel);
    log(`Issue ${issue} ${def.key} posted, awaiting /approve at ${def.gateLabel}.`);
    return { issue, status: "awaiting_approval", gate: def.gateLabel };
  }

  await transitionTo(issue, def.toStatus);
  label = await currentLabel(issue);
}

log(`Issue ${issue} is at ${label}; nothing left for this workflow to drive.`);
return { issue, status: "done", label };
